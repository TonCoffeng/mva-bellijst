exports.handler = async (event) => {
  const CLOZE_API_KEY = process.env.CLOZE_API_KEY;
  const CLOZE_USER    = 'toncoffeng@makelaarsvan.nl';

  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  const { action, data } = JSON.parse(event.body || "{}");

  // Helper: Cloze API call
  const cloze = async (endpoint, body = null, method = 'POST') => {
    const url = `https://api.cloze.com/v1/${endpoint}?api_key=${CLOZE_API_KEY}&user_email=${CLOZE_USER}`;
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    return res.json();
  };

  // Stage mapping op basis van feedback knoppen
  const feedbackNaarStage = (feedback = []) => {
    if (feedback.includes('serieus'))    return 'lead';
    if (feedback.includes('verkoop'))    return 'lead';
    if (feedback.includes('aankoop'))    return 'lead';
    if (feedback.includes('makelaar'))   return 'out';
    if (feedback.includes('noshow'))     return 'out';
    return null; // geen beeld → stage niet wijzigen
  };

  const feedbackNaarLabel = {
    serieus:    '🔥 Serieuze koper',
    verkoop:    '💰 Verkoopprospect',
    aankoop:    '🏠 Aankoopprospect',
    makelaar:   '✋ Heeft aankoopmakelaar',
    geen_beeld: '💭 Geen beeld',
    noshow:     '🚫 No-show',
  };

  try {

    // ── VERWERK LEAD — alles in één ───────────────────────────────────────
    // Aanroepen na feedback opslaan: maakt contact aan (of update),
    // stelt stage in en voegt notitie toe
    if (action === 'verwerk_lead') {
      const { naam, email, telefoon, adres, makelaar_email, feedback, opmerking, stage_override } = data;
      const feedbackKeys = Array.isArray(feedback) ? feedback : (feedback || '').split(',').filter(Boolean);
      const feedbackTekst = feedbackKeys.map(k => feedbackNaarLabel[k] || k).join(', ');
      const stage = stage_override !== undefined ? (stage_override || null) : feedbackNaarStage(feedbackKeys);
      const notitie = `Bezichtiging ${adres} — ${feedbackTekst}${opmerking ? ` — ${opmerking}` : ''}`;

      // 1. Contact aanmaken of updaten (Cloze merget automatisch op email/telefoon)
      const personBody = {
        name: naam,
        ...(email    && { emails: [{ value: email }] }),
        ...(telefoon && { phones: [{ value: telefoon, type: 'mobile' }] }),
        ...(stage    && { stage }),
        assignedTo: makelaar_email,
        atAGlanceNotes: notitie,
      };
      const personResult = await cloze('people/create', personBody);

      // 2. Notitie toevoegen als activiteit
      const noteBody = {
        date: new Date().toISOString(),
        style: 'note',
        account: makelaar_email,
        subject: `Bezichtiging ${adres}`,
        body: notitie,
        recipients: [
          ...(email    ? [{ value: email,    name: naam }] : []),
          ...(telefoon ? [{ value: telefoon, name: naam }] : []),
        ],
      };
      const noteResult = await cloze('timeline/communication/create', noteBody);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          ok: true,
          person: personResult,
          note: noteResult,
          stage_ingesteld: stage || 'niet gewijzigd',
        }),
      };
    }
    if (action === "upsert_person") {
      const { naam, email, telefoon, adres, makelaar_email } = data;

      const body = {
        name: naam,
        stage: "lead",
        keywords: ["Leadpool"],
        assignTo: makelaar_email,
        ...(email && { emails: [{ value: email }] }),
        ...(telefoon && { phones: [{ value: telefoon, mobile: true }] }),
        ...(adres && {
          atAGlanceNotes: `Bezichtigd: ${adres}`,
        }),
      };

      const res = await fetch(
        `https://api.cloze.com/v1/people/create?api_key=${CLOZE_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );
      const result = await res.json();
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    // ── 2. LOG BELPOGING ───────────────────────────────────────────────
    if (action === "log_call") {
      const { telefoon, naam, outcome, notitie, makelaar_email, adres } = data;

      // outcome mapping:
      // "bereikt_ja"      → connected
      // "bereikt_later"   → connected  (met follow-up)
      // "niet_bereikbaar" → noanswer
      // "voicemail"       → leftvm
      // "niet_geinteresseerd" → connected (afsluiten)

      const outcomeMap = {
        bereikt_ja: "connected",
        bereikt_later: "connected",
        niet_bereikbaar: "noanswer",
        voicemail: "leftvm",
        niet_geinteresseerd: "connected",
        wellicht_later: "noanswer",
      };

      const subjectMap = {
        bereikt_ja: `✅ Bereikt — geïnteresseerd | ${adres}`,
        bereikt_later: `📲 Bel later terug | ${adres}`,
        niet_bereikbaar: `📵 Niet bereikbaar | ${adres}`,
        voicemail: `📬 Voicemail ingesproken | ${adres}`,
        niet_geinteresseerd: `❌ Niet geïnteresseerd | ${adres}`,
        wellicht_later: `💤 Wellicht later | ${adres}`,
      };

      const callBody = {
        date: new Date().toISOString(),
        style: "call",
        account: makelaar_email,
        from: makelaar_email,
        subject: subjectMap[outcome] || `Belpoging | ${adres}`,
        body: notitie || "",
        outcome: outcomeMap[outcome] || "noanswer",
        recipients: [
          {
            value: telefoon,
            name: naam,
          },
        ],
      };

      const res = await fetch(
        `https://api.cloze.com/v1/timeline/communication/create?api_key=${CLOZE_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(callBody),
        }
      );
      const result = await res.json();
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    // ── 3. MAAK FOLLOW-UP TODO AAN ────────────────────────────────────
    if (action === "create_todo") {
      const { telefoon, naam, datum, omschrijving, makelaar_email } = data;

      const todoBody = {
        account: makelaar_email,
        date: datum || new Date(Date.now() + 86400000).toISOString(), // morgen standaard
        style: "todo",
        subject: omschrijving || `Nabellen: ${naam}`,
        recipients: [{ value: telefoon, name: naam }],
      };

      const res = await fetch(
        `https://api.cloze.com/v1/timeline/todo/create?api_key=${CLOZE_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(todoBody),
        }
      );
      const result = await res.json();
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    // ── 4. UPDATE PERSOON STAGE ────────────────────────────────────────
    if (action === "update_stage") {
      const { telefoon, email, stage } = data;
      // stage: "lead" | "current" | "out" | "future"

      const identifier = email || telefoon;
      const stageBody = { stage };

      const res = await fetch(
        `https://api.cloze.com/v1/people/update?api_key=${CLOZE_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...stageBody,
            ...(email
              ? { emails: [{ value: email }] }
              : { phones: [{ value: telefoon }] }),
          }),
        }
      );
      const result = await res.json();
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    // ── CHECK OF PERSOON AL IN CLOZE STAAT ────────────────────────────
    // 2026-05-01: scope=team toegevoegd zodat we contacten van het hele MVA-team
    // zien (niet alleen die van de eigen account). Vereist dat de gebruikte
    // API key (MVA Ledpool) de scope "Read Permissions" (read_relation) aan
    // heeft staan in Cloze settings. Verifieerd met Anthea Klijn (assigned to
    // filipebataglia@makelaarsvan.nl): zonder scope=team 0 hits, met scope=team
    // 1 hit incl. assignee veld.
    if (action === "check_bestaand") {
      const { email, telefoon, naam } = data;

      // Zoek op email eerst, dan telefoon, dan naam
      const queries = [email, telefoon, naam].filter(Boolean);
      let gevonden = null;

      for (const query of queries) {
        const url = `https://api.cloze.com/v1/people/find?api_key=${CLOZE_API_KEY}&user_email=${CLOZE_USER}&freeformquery=${encodeURIComponent(query)}&pagesize=1&scope=team`;
        const res = await fetch(url);
        const json = await res.json();

        // 🔍 DEBUG LOG voor Cloze support — toont ruwe respons
        console.log('=== CLOZE FIND DEBUG ===');
        console.log('Query:', query);
        console.log('URL (zonder key):', url.replace(CLOZE_API_KEY, '***'));
        console.log('Raw response:', JSON.stringify(json, null, 2));
        console.log('=== EINDE DEBUG ===');

        if (json?.people?.length > 0) {
          gevonden = json.people[0];
          break;
        }
      }

      // Eigenaar bepalen — bij scope=team geeft Cloze een 'assignee' string
      // (email van de toegewezen makelaar). Houd 'assignedTo' en andere
      // varianten als fallback voor robuustheid.
      let eigenaar_email = null;
      let eigenaar_naam = null;
      if (gevonden) {
        // Primair: assignee (zoals daadwerkelijk teruggegeven door Cloze bij scope=team)
        const assignee = gevonden.assignee;
        if (typeof assignee === 'string') {
          eigenaar_email = assignee;
        } else if (assignee && typeof assignee === 'object') {
          eigenaar_email = assignee.email || assignee.value || null;
          eigenaar_naam = assignee.name || null;
        }

        // Fallback: assignedTo (oudere/alternatieve veldnaam)
        if (!eigenaar_email) {
          const a = gevonden.assignedTo;
          if (typeof a === 'string') {
            eigenaar_email = a;
          } else if (a && typeof a === 'object') {
            eigenaar_email = a.email || a.value || null;
            eigenaar_naam = eigenaar_naam || a.name || null;
          }
        }

        // Verdere fallbacks
        if (!eigenaar_naam && gevonden.assigneeName) eigenaar_naam = gevonden.assigneeName;
        if (!eigenaar_email && gevonden.owner) eigenaar_email = gevonden.owner;
      }

      // Cloze persoon-id — voor "Open in Cloze" knop in de UI
      // Cloze gebruikt meerdere id-velden; we proberen ze in volgorde
      const cloze_id = gevonden
        ? (gevonden.id || gevonden.direct || gevonden.portableId || gevonden.syncKey || null)
        : null;

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          bestaand: !!gevonden,
          id: cloze_id,
          naam: gevonden?.name || null,
          stage: gevonden?.stage || null,
          // Hoeveel interacties er al zijn (geeft inschatting van relatiediepte)
          interacties: gevonden?.engagement?.score || null,
          // Eigenaar van het contact in Cloze (null = ongekoppeld)
          eigenaar_email,
          eigenaar_naam,
        }),
      };
    }

    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Onbekende actie" }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
