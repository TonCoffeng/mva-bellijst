exports.handler = async (event) => {
  const CLOZE_API_KEY = process.env.CLOZE_API_KEY;

  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  const { action, data } = JSON.parse(event.body || "{}");

  try {
    // ── 1. ZOEK OF MAAK PERSOON AAN IN CLOZE ──────────────────────────
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
