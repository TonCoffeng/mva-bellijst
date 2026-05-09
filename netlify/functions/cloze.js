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

      // Zoek alleen op email en telefoon — die zijn uniek genoeg om
      // safe te matchen. Naam-zoek leverde fuzzy false-positives op
      // (bv. "Eveline Kraan" → "Roos Solleveld" via naam-deel match).
      // Naam wordt alleen gebruikt om de match te valideren als laatste check.
      const queries = [email, telefoon].filter(Boolean);
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
            // Telefoon match (verwijder spaties/tekens voor vergelijking)
            if (telefoon && Array.isArray(p.phones)) {
              const tel = telefoon.replace(/\D/g, '');
              const heeftMatch = p.phones.some(ph => {
                const v = (ph.value || ph || '').replace(/\D/g, '');
                return v && (v === tel || v.endsWith(tel) || tel.endsWith(v));
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
      const VENSTER_DAGEN = 90;
      const MVA_DOMEINEN = ['@makelaarsvan.nl', '@teunisse.nl'];

      // STAP 1 — Zoek persoon via people/find (zelfde patroon als check_bestaand)
      const queries = [email, telefoon].filter(Boolean);
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
                const tel = telefoon.replace(/\D/g, '');
                if (p.phones.some(ph => {
                  const v = (ph.value || ph || '').replace(/\D/g, '');
                  return v && (v === tel || v.endsWith(tel) || tel.endsWith(v));
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
          }),
        };
      }

      // STAP 2 — Bepaal eigenaar (assignedTo)
      const a = gevonden.assignedTo;
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
          }),
        };
      }

      // STAP 3 — Haal verse person details op (people/get) voor lastChanged
      // Cloze heeft geen tijdlijn-API; lastChanged is onze proxy voor "recent contact".
      const portableId = gevonden.portableId || gevonden.id || gevonden._id;
      let lastChanged = gevonden.lastChanged || null;
      let firstSeen = gevonden.firstSeen || null;

      if (portableId && !lastChanged) {
        try {
          const getRes = await fetch(
            `https://api.cloze.com/v1/people/get?api_key=${CLOZE_API_KEY}&uniqueid=${encodeURIComponent(portableId)}`
          );
          const getJson = await getRes.json();
          const p = getJson?.person || getJson;
          lastChanged = p?.lastChanged || lastChanged;
          firstSeen = p?.firstSeen || firstSeen;
        } catch (e) { /* lastChanged blijft null → behandelen als oud */ }
      }

      // Bepaal of contact recent is
      const VENSTER_MS = VENSTER_DAGEN * 24 * 60 * 60 * 1000;
      const lastChangedTs = lastChanged ? new Date(lastChanged).getTime() : null;
      const dagenGeleden = lastChangedTs
        ? Math.floor((Date.now() - lastChangedTs) / (24 * 60 * 60 * 1000))
        : null;
      const recentContact = lastChangedTs && (Date.now() - lastChangedTs) < VENSTER_MS;

      // REGEL 3 — geen recent contact → naar pool
      if (!recentContact) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            routing: "pool",
            reden: dagenGeleden !== null
              ? `Geen recent contact (laatste activiteit ${dagenGeleden} dagen geleden, ouder dan ${VENSTER_DAGEN}d)`
              : `Geen lastChanged-datum bekend — behandeld als ouder dan ${VENSTER_DAGEN}d`,
            makelaar_email,
            makelaar_naam,
            laatste_activiteit_datum: lastChanged,
            dagen_geleden: dagenGeleden,
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
            laatste_activiteit_datum: lastChanged,
            dagen_geleden: dagenGeleden,
          }),
        };
      }

      // REGEL 2 — actieve MvA-makelaar + recent contact → naar die makelaar
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          routing: "naar_makelaar",
          reden: `Klant heeft actief contact met ${makelaar_naam || makelaar_email} (laatste activiteit ${dagenGeleden} dagen geleden)`,
          makelaar_email,
          makelaar_naam,
          laatste_activiteit_datum: lastChanged,
          dagen_geleden: dagenGeleden,
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
