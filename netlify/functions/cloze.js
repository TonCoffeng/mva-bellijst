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

  // ── DREMPEL: welke feedback-keuzes mogen wél naar Cloze schrijven ─────
  // Alleen "echte interesse"-signalen leiden tot Cloze-actie. Geen klant?
  // Geen Cloze. Dit voorkomt dat elke bezichtiger een record krijgt en
  // Cloze AI workflows triggert die niet relevant zijn.
  const POSITIEVE_FEEDBACK = ['serieus', 'verkoop', 'aankoop'];

  const heeftPositieveFeedback = (feedbackKeys = []) =>
    feedbackKeys.some(k => POSITIEVE_FEEDBACK.includes(k));

  // Stage mapping op basis van feedback knoppen (alleen positieve gevallen)
  const feedbackNaarStage = (feedback = []) => {
    if (feedback.includes('serieus')) return 'lead';
    if (feedback.includes('verkoop')) return 'lead';
    if (feedback.includes('aankoop')) return 'lead';
    return null;
  };

  const feedbackNaarLabel = {
    serieus:    '🔥 Serieuze koper',
    verkoop:    '💰 Verkoopprospect',
    aankoop:    '🏠 Aankoopprospect',
    makelaar:   '✋ Heeft aankoopmakelaar',
    geen_beeld: '💭 Geen beeld',
    noshow:     '🚫 No-show',
  };

  // Helper: zoek persoon strikt op email + telefoon (geen fuzzy name search)
  // Returnt portableId + minimale info, of null.
  // Strikt = alleen accepteren als gevonden persoon ook echt het email/telefoon
  // bevat dat we zochten (voorkomt Eveline Kraan → Roos Solleveld bug).
  const zoekPersoonStrict = async (email, telefoon) => {
    const queries = [email, telefoon].filter(Boolean);
    for (const query of queries) {
      const res = await fetch(
        `https://api.cloze.com/v1/people/find?api_key=${CLOZE_API_KEY}&freeformquery=${encodeURIComponent(query)}&pagesize=5`
      );
      const json = await res.json();
      const kandidaten = json?.people || [];
      // Valideer match: persoon moet daadwerkelijk dit email/telefoon hebben
      for (const p of kandidaten) {
        const emails = (p.emails || []).map(e => (e.value || '').toLowerCase());
        const phones = (p.phones || []).map(t => (t.value || '').replace(/\D/g, ''));
        const telDigits = (telefoon || '').replace(/\D/g, '');
        if (email && emails.includes(email.toLowerCase())) return p;
        if (telDigits && phones.some(p => p && p.includes(telDigits.slice(-9)))) return p;
      }
    }
    return null;
  };

  try {

    // ── VERWERK LEAD — feedback uit bezichtiging ──────────────────────────
    // Alleen Cloze-actie bij positieve feedback (serieus/verkoop/aankoop).
    // Bij andere feedback (makelaar/noshow/geen_beeld) wordt er NIETS naar
    // Cloze geschreven — voorkomt vervuiling van CRM met dode leads.
    if (action === 'verwerk_lead') {
      const { naam, email, telefoon, adres, makelaar_email, feedback, opmerking, stage_override } = data;
      const feedbackKeys = Array.isArray(feedback) ? feedback : (feedback || '').split(',').filter(Boolean);

      // DREMPEL: geen positieve feedback → geen Cloze-actie
      if (!heeftPositieveFeedback(feedbackKeys) && stage_override === undefined) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            ok: true,
            skipped: true,
            reden: 'Geen positieve feedback — Cloze ongemoeid',
            stage_ingesteld: 'niet gewijzigd (drempel)',
          }),
        };
      }

      const feedbackTekst = feedbackKeys.map(k => feedbackNaarLabel[k] || k).join(', ');
      const stage = stage_override !== undefined
        ? (stage_override || null)
        : feedbackNaarStage(feedbackKeys);
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

    // ── LEGACY: upsert_person ─────────────────────────────────────────────
    // Niet meer gebruikt vanuit nieuwe slaOpEnSluit, maar blijft beschikbaar
    // voor backwards compatibility.
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

    // ── LOG_CALL_V2 — drempel-gebaseerde belregistratie ───────────────────
    // Vervangt het oude log_call. Logica:
    //   1. Zoek persoon strikt op email+telefoon
    //   2. Persoon BESTAAT in Cloze:
    //      - Voeg notitie toe aan timeline met adres + uitkomst
    //      - GEEN stage-wijziging (klant kan A/B/C/D zijn bij collega)
    //   3. Persoon BESTAAT NIET:
    //      - "bereikt_ja"  → aanmaken als nieuwe lead + call log
    //      - alle andere uitkomsten → niets doen, alleen Supabase status
    //
    // De frontend moet bij "bereikt_ja" voor klant-van-collega eerst
    // bevestiging vragen vóór deze action wordt aangeroepen.
    if (action === "log_call_v2") {
      const { telefoon, email, naam, outcome, notitie, makelaar_email, adres, force_aanmaken } = data;

      const subjectMap = {
        bereikt_ja:           `✅ Bereikt — geïnteresseerd | ${adres}`,
        bereikt_later:        `📲 Bel later terug | ${adres}`,
        niet_bereikbaar:      `📵 Niet bereikbaar | ${adres}`,
        voicemail:            `📬 Voicemail ingesproken | ${adres}`,
        niet_geinteresseerd:  `❌ Niet geïnteresseerd | ${adres}`,
        wellicht_later:       `💤 Wellicht later | ${adres}`,
      };

      const outcomeMap = {
        bereikt_ja:          'connected',
        bereikt_later:       'connected',
        niet_bereikbaar:     'noanswer',
        voicemail:           'leftvm',
        niet_geinteresseerd: 'connected',
        wellicht_later:      'noanswer',
      };

      // Stap 1: bestaat persoon?
      const bestaand = await zoekPersoonStrict(email, telefoon);

      // Stap 2: persoon BESTAAT → notitie + call log toevoegen (geen stage)
      if (bestaand) {
        const subject = subjectMap[outcome] || `Belpoging | ${adres}`;

        // Call log toevoegen — Cloze koppelt dit aan persoon via recipients
        const callBody = {
          date: new Date().toISOString(),
          style: 'call',
          account: makelaar_email,
          from: makelaar_email,
          subject,
          body: notitie || '',
          outcome: outcomeMap[outcome] || 'noanswer',
          recipients: [
            ...(email    ? [{ value: email,    name: naam }] : []),
            ...(telefoon ? [{ value: telefoon, name: naam }] : []),
          ],
        };

        const callRes = await fetch(
          `https://api.cloze.com/v1/timeline/communication/create?api_key=${CLOZE_API_KEY}&user_email=${CLOZE_USER}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(callBody),
          }
        );
        const callResult = await callRes.json();

        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            ok: true,
            mode: 'bestaande_persoon',
            portableId: bestaand.portableId || null,
            persoon_naam: bestaand.name || null,
            persoon_stage: bestaand.stage || null,
            call_log: callResult,
            stage_gewijzigd: false,
            reden_geen_stage: 'Bestaande klant — eigenaar beslist zelf',
          }),
        };
      }

      // Stap 3: persoon BESTAAT NIET in Cloze
      // - "bereikt_ja" of force_aanmaken → aanmaken
      // - alle andere uitkomsten → niets doen
      const magAanmaken = outcome === 'bereikt_ja' || force_aanmaken === true;

      if (!magAanmaken) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            ok: true,
            mode: 'skip',
            reden: 'Persoon niet in Cloze en uitkomst is geen positief signaal — niets geschreven',
            outcome,
          }),
        };
      }

      // Aanmaken als nieuwe lead
      const personBody = {
        name: naam,
        stage: 'lead',
        keywords: ['Leadpool'],
        assignedTo: makelaar_email,
        ...(email    && { emails: [{ value: email }] }),
        ...(telefoon && { phones: [{ value: telefoon, type: 'mobile' }] }),
        atAGlanceNotes: `Bereikt via bezichtiging ${adres}`,
      };
      const personRes = await fetch(
        `https://api.cloze.com/v1/people/create?api_key=${CLOZE_API_KEY}&user_email=${CLOZE_USER}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(personBody),
        }
      );
      const personResult = await personRes.json();

      // Call log toevoegen aan nieuwe persoon
      const callBody = {
        date: new Date().toISOString(),
        style: 'call',
        account: makelaar_email,
        from: makelaar_email,
        subject: subjectMap[outcome] || `Belpoging | ${adres}`,
        body: notitie || '',
        outcome: outcomeMap[outcome] || 'connected',
        recipients: [
          ...(email    ? [{ value: email,    name: naam }] : []),
          ...(telefoon ? [{ value: telefoon, name: naam }] : []),
        ],
      };
      const callRes = await fetch(
        `https://api.cloze.com/v1/timeline/communication/create?api_key=${CLOZE_API_KEY}&user_email=${CLOZE_USER}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(callBody),
        }
      );
      const callResult = await callRes.json();

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          ok: true,
          mode: 'nieuwe_persoon',
          portableId: personResult.portableId || null,
          person: personResult,
          call_log: callResult,
        }),
      };
    }

    // ── LEGACY: log_call (oude flow) ──────────────────────────────────────
    // Niet meer gebruikt vanuit slaOpEnSluit, maar blijft staan voor
    // backwards compatibility en handmatige calls vanuit andere modules.
    if (action === "log_call") {
      const { telefoon, email, naam, outcome, notitie, makelaar_email, adres } = data;

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

      // Zoek strikt op email/telefoon (geen fuzzy name search → voorkomt
      // Eveline Kraan → Roos Solleveld bug door gedeelde email-domeinen)
      const gevonden = await zoekPersoonStrict(email, telefoon);

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
        if (!eigenaar_naam && gevonden.assigneeName) eigenaar_naam = gevonden.assigneeName;
        if (!eigenaar_email && gevonden.owner) eigenaar_email = gevonden.owner;
      }

      // Normaliseer Cloze's "none"-strings naar null
      const norm = (v) => (v === 'none' || v === '' ? null : v);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          bestaand: !!gevonden,
          id: gevonden?.portableId || null,
          naam: gevonden?.name || null,
          stage: norm(gevonden?.stage),
          segment: norm(gevonden?.segment),
          pinned: !!gevonden?.pinned,
          created_at: gevonden?.created || null,
          interacties: gevonden?.engagement?.score || null,
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
