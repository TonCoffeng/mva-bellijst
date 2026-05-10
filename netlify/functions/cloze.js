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

  // Cloze indexeert telefoonnummers in E.164-formaat (+31...).
  // Realworks/onze leads geven 06... — moet vóór de Cloze-query
  // genormaliseerd worden, anders vindt Cloze niets.
  const normalizeTelToE164NL = (tel) => {
    if (!tel) return null;
    const trimmed = String(tel).trim();
    const digits = trimmed.replace(/\D/g, '');
    if (!digits) return null;
    if (trimmed.startsWith('+')) return '+' + digits;        // al E.164
    if (digits.startsWith('31'))  return '+' + digits;       // 31... zonder +
    if (digits.startsWith('0'))   return '+31' + digits.slice(1); // 06... of 020...
    if (digits.length === 8)      return '+316' + digits;    // mobiel zonder 0
    return trimmed;                                          // onbekend, ongewijzigd
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

      // Cloze slaat telefoons op in E.164 (+31...). Normaliseer 06... → +316...
      // anders vindt freeformquery ze niet. (Bevestigd 9 mei 2026.)
      const telE164 = normalizeTelToE164NL(telefoon);

      // Zoek alleen op email en telefoon — die zijn uniek genoeg om
      // safe te matchen. Naam-zoek leverde fuzzy false-positives op
      // (bv. "Eveline Kraan" → "Roos Solleveld" via naam-deel match).
      // Naam wordt alleen gebruikt om de match te valideren als laatste check.
      const queries = [email, telE164].filter(Boolean);
      let gevonden = null;

      for (const query of queries) {
        const res = await fetch(
          `https://api.cloze.com/v1/people/find?api_key=${CLOZE_API_KEY}&freeformquery=${encodeURIComponent(query)}&pagesize=3`
        );
        const json = await res.json();
        if (json?.people?.length > 0) {
          // Valideer match: het gevonden contact moet email of telefoon
          // bevatten die we zochten. Zo niet, was het een fuzzy match — overslaan.
          const valid = json.people.find(p => {
            // Email match
            if (email && Array.isArray(p.emails)) {
              const heeftMatch = p.emails.some(e =>
                (e.value || e).toLowerCase() === email.toLowerCase()
              );
              if (heeftMatch) return true;
            }
            // Telefoon match — Cloze slaat op als +31..., wij krijgen vaak 06...
            // Vergelijk daarom op de "kale" laatste 9 cijfers (NL mobiel zonder prefix).
            if (telefoon && Array.isArray(p.phones)) {
              const stripPrefix = (s) => {
                let d = String(s || '').replace(/\D/g, '');
                if (d.startsWith('31')) d = d.slice(2);  // 31646... → 646...
                if (d.startsWith('0'))  d = d.slice(1);  // 0646... → 646...
                return d;
              };
              const tel = stripPrefix(telefoon);
              const heeftMatch = p.phones.some(ph => {
                const v = stripPrefix(ph.value || ph);
                return v && tel && (v === tel || v.endsWith(tel) || tel.endsWith(v));
              });
              if (heeftMatch) return true;
            }
            return false;
          });
          if (valid) {
            gevonden = valid;
            break;
          }
        }
      }

      // Eigenaar bepalen — Cloze response heeft 'assignee'
      // (bevestigd 9 mei 2026; 'assignedTo' bestaat niet in find/get).
      let eigenaar_email = null;
      let eigenaar_naam = null;
      if (gevonden) {
        const a = gevonden.assignee || gevonden.assignedTo;
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

      // ── KLANT-STERKTE-SIGNALEN — voor "echte klant" detectie ──────────
      // Cloze velden om de relatiediepte te bepalen. Velden die niet bestaan
      // zijn null, dat is OK — frontend filtert dan naar 'zwak'.
      // - segment: 'A' / 'B' / 'C' / 'D' (priority-letter)
      // - pinned: true/false (handmatig vinkje door eigenaar)
      // - createdAt: ISO datum waarop contact is aangemaakt
      // - engagement.score: 0-100
      // Klant-sterkte signalen — let op: Cloze stuurt soms de letterlijke
      // string "none" terug ipv null. Behandelen als leeg.
      const norm = (v) => (!v || v === 'none' || v === 'None') ? null : v;
      const segment    = norm(gevonden?.segment) || norm(gevonden?.priority);
      const stage      = norm(gevonden?.stage);
      const pinned     = !!(gevonden?.pinned || gevonden?.priority === 'high');
      const created_at = gevonden?.createdAt || gevonden?.created_at || null;

      // Cloze-id: het echte veld is `portableId` (uit live response geconfirmeerd).
      // De andere namen blijven als fallback voor robuustheid.
      const cloze_id = gevonden?.portableId || gevonden?.id || gevonden?.personId || gevonden?._id || gevonden?.pid || null;

      // Debug: alle top-level velden van Cloze response (alleen veld-namen).
      const debug_velden = gevonden ? Object.keys(gevonden).slice(0, 30) : [];

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          bestaand: !!gevonden,
          id: cloze_id,
          naam: gevonden?.name || null,
          stage,
          interacties: gevonden?.engagement?.score || null,
          segment,
          pinned,
          created_at,
          eigenaar_email,
          eigenaar_naam,
          _debug_velden: debug_velden,
        }),
      };
    }

    // ── POOL ROUTING CHECK ─────────────────────────────────────────────
    // Bepaalt of een lead direct naar een specifieke makelaar moet (omdat
    // klant al actief contact heeft met een MvA-makelaar) of via Round Robin
    // naar de pool. Beslislogica:
    //   1. Klant niet in Cloze → pool
    //   2. Klant in Cloze + actieve MvA-eigenaar + lastChanged < 90d → makelaar
    //   3. Klant in Cloze maar lastChanged ≥ 90d → pool (record te oud)
    //
    // OPMERKING: `lastChanged` is een proxy voor "recent contact". Cloze
    // heeft geen publiek endpoint om individuele tijdlijn-items op te halen
    // (alleen people/feed voor bulk sync of webhooks). lastChanged schuift
    // wanneer een email/call/note/todo aan het record wordt toegevoegd, maar
    // ook bij handmatige wijzigingen (stage, segment). Niet 100% accuraat
    // maar goed genoeg voor 90-dagen-grens.
    //
    // Aanroep: { action: "pool_routing_check", data: { email, telefoon, naam, gevende_makelaar_email } }
    //   gevende_makelaar_email is optioneel — als gevuld én gelijk aan de Cloze-eigenaar,
    //   dan gaat de lead naar pool (de gevende makelaar IS de eigenaar; hij wil hem juist weggeven).
    if (action === "pool_routing_check") {
      const { email, telefoon, naam, gevende_makelaar_email } = data;
      const MVA_DOMEINEN = ['@makelaarsvan.nl', '@teunisse.nl'];

      // Cloze slaat telefoons op in E.164. Normaliseer vóór de query.
      const telE164 = normalizeTelToE164NL(telefoon);

      // STAP 1 — Zoek persoon via people/find (zelfde patroon als check_bestaand)
      const queries = [email, telE164].filter(Boolean);
      let gevonden = null;

      try {
        for (const query of queries) {
          const res = await fetch(
            `https://api.cloze.com/v1/people/find?api_key=${CLOZE_API_KEY}&freeformquery=${encodeURIComponent(query)}&pagesize=3`
          );
          const json = await res.json();
          if (json?.people?.length > 0) {
            // Valideer match op email of telefoon (geen fuzzy naam-match)
            const valid = json.people.find(p => {
              if (email && Array.isArray(p.emails)) {
                if (p.emails.some(e => (e.value || e).toLowerCase() === email.toLowerCase())) return true;
              }
              if (telefoon && Array.isArray(p.phones)) {
                const stripPrefix = (s) => {
                  let d = String(s || '').replace(/\D/g, '');
                  if (d.startsWith('31')) d = d.slice(2);
                  if (d.startsWith('0'))  d = d.slice(1);
                  return d;
                };
                const tel = stripPrefix(telefoon);
                if (p.phones.some(ph => {
                  const v = stripPrefix(ph.value || ph);
                  return v && tel && (v === tel || v.endsWith(tel) || tel.endsWith(v));
                })) return true;
              }
              return false;
            });
            if (valid) { gevonden = valid; break; }
          }
        }
      } catch (e) {
        // Cloze API down/timeout → fallback naar pool (regel 3 fail-safe)
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            routing: "pool",
            reden: "Cloze-check niet beschikbaar — lead gaat naar pool",
            error: e.message,
          }),
        };
      }

      // REGEL 1 — niet gevonden in Cloze
      if (!gevonden) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            routing: "pool",
            reden: "Klant niet bekend in Cloze",
            cloze_url: null,
          }),
        };
      }

      // STAP 2 — Bepaal eigenaar
      // Cloze response heeft 'assignee' (bevestigd 9 mei 2026 via _debug_velden).
      // Oude code keek naar 'assignedTo' — bestaat niet in find/get response.
      // Beide proberen voor robuustheid; eerste niet-leeg wint.
      const portableId = gevonden.portableId || gevonden.id || gevonden._id;
      const cloze_url = portableId
        ? `https://app.cloze.com/app/#/people/${portableId}`
        : null;

      const a = gevonden.assignee || gevonden.assignedTo;
      let makelaar_email = null;
      let makelaar_naam = null;
      if (typeof a === 'string') {
        makelaar_email = a;
      } else if (a && typeof a === 'object') {
        makelaar_email = a.email || a.value || null;
        makelaar_naam = a.name || null;
      }
      if (!makelaar_naam && gevonden.assigneeName) makelaar_naam = gevonden.assigneeName;
      if (!makelaar_email && gevonden.owner) makelaar_email = gevonden.owner;

      const isMvaEigenaar = makelaar_email
        && MVA_DOMEINEN.some(d => makelaar_email.toLowerCase().endsWith(d));

      // Als geen MvA-eigenaar → naar pool (Niels Ottink van Effytool, externe partners, etc.)
      if (!isMvaEigenaar) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            routing: "pool",
            reden: makelaar_email
              ? `Eigenaar ${makelaar_email} is geen MvA-makelaar`
              : "Klant heeft geen eigenaar in Cloze",
            cloze_url,
          }),
        };
      }

      // STAP 3 — Stage-check (vervangt lastChanged proxy van 9 mei)
      // Cloze person-API geeft geen activiteits-data terug; alleen het
      // person-record met stage. Stage is wat de makelaar zelf onderhoudt:
      //   lead/current/future = actieve relatie  → naar makelaar
      //   out/closed/null     = niet meer actief → naar pool
      const stage = (gevonden.stage || '').toLowerCase();

      const ACTIEVE_STAGES = ['lead', 'current', 'future'];
      const isActief = ACTIEVE_STAGES.includes(stage);

      // REGEL 3 — niet-actieve stage → naar pool
      if (!isActief) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            routing: "pool",
            reden: stage
              ? `Klant in Cloze met stage "${stage}" — niet meer actief`
              : `Klant in Cloze maar zonder stage — behandeld als niet-actief`,
            makelaar_email,
            makelaar_naam,
            stage: stage || null,
            cloze_url,
          }),
        };
      }

      // CHECK — gevende makelaar IS zelf de eigenaar
      // (hij doet de bezichtiging, ziet "actief contact", maar wil hem
      // juist doorgeven aan pool; hij heeft hem zelf.)
      if (gevende_makelaar_email
          && makelaar_email
          && gevende_makelaar_email.toLowerCase() === makelaar_email.toLowerCase()) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            routing: "pool",
            reden: `Je bent zelf de eigenaar in Cloze — lead gaat naar pool`,
            makelaar_email,
            makelaar_naam,
            stage,
            cloze_url,
          }),
        };
      }

      // REGEL 2 — actieve MvA-makelaar + actieve stage → naar die makelaar
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          routing: "naar_makelaar",
          reden: `Actieve klant van ${makelaar_naam || makelaar_email} (stage: ${stage})`,
          makelaar_email,
          makelaar_naam,
          stage,
          cloze_url,
        }),
      };
    }

    // ── KLANT AANMAKEN OF UPDATEN ────────────────────────────────────────
    // Wordt aangeroepen wanneer makelaar een lead-status zet op
    // Hot/Warm/Afspraak/Deal — dan moet de klant in Cloze actief worden.
    // Stap 1: zoek of klant al bestaat (people/find op email/telefoon)
    // Stap 2a: bestaat → people/update met segment+stage+assignee
    // Stap 2b: bestaat niet → people/create met alle data
    // Returns: { ok, actie: "aangemaakt"|"bijgewerkt", portableId, cloze_url }
    if (action === "klant_aanmaken_of_updaten") {
      const { naam, email, telefoon, adres, segment, stage, lead_status, makelaar_email } = data;

      // Cloze indexeert telefoons in E.164
      const telE164 = normalizeTelToE164NL(telefoon);

      // STAP 1 — zoek bestaande klant via email/telefoon
      const queries = [email, telE164].filter(Boolean);
      let bestaand = null;

      for (const q of queries) {
        const findRes = await fetch(
          `https://api.cloze.com/v1/people/find?api_key=${CLOZE_API_KEY}&freeformquery=${encodeURIComponent(q)}&pagesize=3`
        );
        const findJson = await findRes.json();
        const matches = Array.isArray(findJson?.people) ? findJson.people : [];
        const valid = matches.find(p => {
          if (email && Array.isArray(p.emails)) {
            if (p.emails.some(e => (e.value || e || '').toLowerCase() === email.toLowerCase())) return true;
          }
          if (telE164 && Array.isArray(p.phones)) {
            const stripPrefix = (s) => {
              let d = String(s || '').replace(/\D/g, '');
              if (d.startsWith('31')) d = d.slice(2);
              if (d.startsWith('0'))  d = d.slice(1);
              return d;
            };
            const tel = stripPrefix(telE164);
            if (p.phones.some(ph => {
              const v = stripPrefix(ph.value || ph);
              return v && tel && (v === tel || v.endsWith(tel) || tel.endsWith(v));
            })) return true;
          }
          return false;
        });
        if (valid) { bestaand = valid; break; }
      }

      // Notitie voor in Cloze (bouw 'm één keer)
      const notitie = `Lead ${lead_status} via Bellijst${adres ? ` — bezichtigd ${adres}` : ''}`;

      // STAP 2a — bestaat: update met nieuwe segment + stage + assignee
      if (bestaand) {
        const updateBody = {
          // Cloze update vereist een unique identifier in body
          ...(email    ? { emails: [{ value: email }] }
            : telE164  ? { phones: [{ value: telE164 }] }
            : {}),
          ...(segment  && { segment }),
          ...(stage    && { stage }),
          ...(makelaar_email && { assignee: makelaar_email }),
          atAGlanceNotes: notitie,
        };
        const updateRes = await fetch(
          `https://api.cloze.com/v1/people/update?api_key=${CLOZE_API_KEY}&user_email=${encodeURIComponent(CLOZE_USER)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updateBody)
          }
        );
        const updateJson = await updateRes.json();
        const portableId = bestaand.portableId || bestaand.id || null;
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            ok: !updateJson?.errorcode || updateJson.errorcode === 0,
            actie: 'bijgewerkt',
            portableId,
            cloze_url: portableId ? `https://app.cloze.com/app/#/people/${portableId}` : null,
            cloze_response: updateJson,
          }),
        };
      }

      // STAP 2b — bestaat niet: aanmaken
      const createBody = {
        name: naam || (email || telefoon || 'Onbekend'),
        ...(email    && { emails: [{ value: email }] }),
        ...(telE164  && { phones: [{ value: telE164, type: 'mobile' }] }),
        ...(segment  && { segment }),
        ...(stage    && { stage }),
        ...(makelaar_email && { assignee: makelaar_email }),
        atAGlanceNotes: notitie,
      };
      const createRes = await fetch(
        `https://api.cloze.com/v1/people/create?api_key=${CLOZE_API_KEY}&user_email=${encodeURIComponent(CLOZE_USER)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(createBody)
        }
      );
      const createJson = await createRes.json();
      const newPortableId = createJson?.person?.portableId || createJson?.portableId || null;
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          ok: !createJson?.errorcode || createJson.errorcode === 0,
          actie: 'aangemaakt',
          portableId: newPortableId,
          cloze_url: newPortableId ? `https://app.cloze.com/app/#/people/${newPortableId}` : null,
          cloze_response: createJson,
        }),
      };
    }

    // ── DEBUG (tijdelijk) — toon alle tijd-velden van een Cloze persoon ─
    // Doel: ontdekken welk veld de "laatste activiteit" weerspiegelt.
    // lastChanged blijkt te schuiven bij record-edits, niet bij activiteiten.
    // Aanroep: { action: "pool_routing_debug", data: { telefoon: "+316..." } }
    if (action === "pool_routing_debug") {
      const { email, telefoon } = data;
      const telE164 = normalizeTelToE164NL(telefoon);

      const q = email || telE164;
      if (!q) return { statusCode: 400, headers, body: JSON.stringify({ error: "geen email of telefoon" }) };
      const findRes = await fetch(
        `https://api.cloze.com/v1/people/find?api_key=${CLOZE_API_KEY}&freeformquery=${encodeURIComponent(q)}&pagesize=3`
      );
      const findJson = await findRes.json();
      const findFirst = findJson?.people?.[0];

      let getPerson = null;
      if (findFirst?.portableId) {
        const getRes = await fetch(
          `https://api.cloze.com/v1/people/get?api_key=${CLOZE_API_KEY}&uniqueid=${encodeURIComponent(findFirst.portableId)}`
        );
        const getJson = await getRes.json();
        getPerson = getJson?.person || null;
      }

      const tijdVelden = (obj) => {
        if (!obj) return null;
        const out = {};
        for (const k of Object.keys(obj)) {
          const lk = k.toLowerCase();
          if (lk.includes('date') || lk.includes('time') || lk.includes('seen') ||
              lk.includes('changed') || lk.includes('engage') || lk.includes('contact') ||
              lk.includes('activ') || lk.includes('last') || lk.includes('first') ||
              lk.includes('created') || lk.includes('updated')) {
            const v = obj[k];
            const iso = (typeof v === 'number' && v > 1000000000000)
              ? new Date(v).toISOString()
              : null;
            out[k] = iso ? `${v} (${iso})` : v;
          }
        }
        return out;
      };

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          query: q,
          found: !!findFirst,
          name: findFirst?.name,
          portableId: findFirst?.portableId,
          assignee: findFirst?.assignee || findFirst?.assignedTo || null,
          find_alle_keys: findFirst ? Object.keys(findFirst) : null,
          find_tijd_velden: tijdVelden(findFirst),
          get_alle_keys: getPerson ? Object.keys(getPerson) : null,
          get_tijd_velden: tijdVelden(getPerson),
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
