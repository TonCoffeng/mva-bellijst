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
    if (action === "check_bestaand") {
      const { email, telefoon, naam } = data;

      // Stap 1: Zoek op email eerst, dan telefoon, dan naam
      const queries = [email, telefoon, naam].filter(Boolean);
      let gevondenLijst = null;

      for (const query of queries) {
        const res = await fetch(
          `https://api.cloze.com/v1/people/find?api_key=${CLOZE_API_KEY}&freeformquery=${encodeURIComponent(query)}&pagesize=1`
        );
        const json = await res.json();
        if (json?.people?.length > 0) {
          gevondenLijst = json.people[0];
          break;
        }
      }

      // Stap 2: Als gevonden, haal de volledige details op via people/get
      // (find geeft maar beperkte info terug — geen stage, geen assignedTo)
      let gevonden = gevondenLijst;
      if (gevondenLijst) {
        try {
          // Cloze gebruikt 'userKey' als identifier — dat is wat we terugkregen
          const lookupKey = gevondenLijst.userKey || gevondenLijst.id || gevondenLijst.uniqueId || gevondenLijst.emails?.[0]?.value;
          if (lookupKey) {
            // Probeer met 'view=full' om alle velden te krijgen
            const detailRes = await fetch(
              `https://api.cloze.com/v1/people/get?api_key=${CLOZE_API_KEY}&user_email=${CLOZE_USER}&id=${encodeURIComponent(lookupKey)}&view=full`
            );
            const detailJson = await detailRes.json();
            if (detailJson?.userKey || detailJson?.name) {
              gevonden = detailJson;
            }
          }
        } catch (e) {
          // Bij fout: val terug op de find-resultaten
        }
      }

      // Eigenaar bepalen — Cloze geeft 'assignedTo' (email of object met email/name)
      let eigenaar_email = null;
      let eigenaar_naam = null;
      if (gevonden) {
        const a = gevonden.assignedTo;
        if (typeof a === 'string') {
          eigenaar_email = a;
        } else if (a && typeof a === 'object') {
          eigenaar_email = a.email || a.value || null;
          eigenaar_naam = a.name || null;
        }
        // Fallback: bekijk ook 'assigneeName' / 'owner' indien aanwezig
        if (!eigenaar_naam && gevonden.assigneeName) eigenaar_naam = gevonden.assigneeName;
        if (!eigenaar_email && gevonden.owner) eigenaar_email = gevonden.owner;
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          bestaand: !!gevonden,
          naam: gevonden?.name || null,
          stage: gevonden?.stage || null,
          // Hoeveel interacties er al zijn (geeft inschatting van relatiediepte)
          interacties: gevonden?.engagement?.score || null,
          // Eigenaar van het contact in Cloze (null = ongekoppeld)
          eigenaar_email,
          eigenaar_naam,
          // DEBUG: rauwe Cloze data zodat we kunnen zien welke velden er zijn
          _debug_find_keys: gevondenLijst ? Object.keys(gevondenLijst) : [],
          _debug_get_keys: gevonden ? Object.keys(gevonden) : [],
          _debug_assignedTo: gevonden?.assignedTo,
          _debug_assignee: gevonden?.assignee,
          _debug_owner: gevonden?.owner,
          _debug_segments: gevonden?.segments,
          _debug_segment_value: gevonden?.segment,
          _debug_step_value: gevonden?.step,
          _debug_emails: gevonden?.emails,
          _debug_userkey: gevonden?.userKey,
          _debug_lookupkey_used: gevondenLijst ? (gevondenLijst.id || gevondenLijst.uniqueId || gevondenLijst.uniqueid || gevondenLijst.userKey || gevondenLijst.emails?.[0]?.value) : null,
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
