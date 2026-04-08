exports.handler = async (event) => {
  const MONDAY_TOKEN = process.env.MONDAY_TOKEN;

  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  const { action, data } = JSON.parse(event.body || "{}");

  const token = MONDAY_TOKEN.startsWith('Bearer ')
    ? MONDAY_TOKEN
    : `Bearer ${MONDAY_TOKEN}`;

  const mondayFetch = async (query, variables = {}) => {
    const res = await fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: token,
        "API-Version": "2024-01",
      },
      body: JSON.stringify({ query, variables }),
    });
    return res.json();
  };

  // Exacte kolom-IDs van Bellijst_Matthias / Bellijst_Maurits
  const COL = {
    telefoon:          "phone_mm1fzq2g",
    email:             "email_mm1fnwvn",
    datum_ontvangen:   "date_mm1f1fw2",
    status:            "color_mm1f9atj",
    warme_lead:        "boolean_mm1fnaay",
    bezichtigd_adres:  "text_mm1frktj",
    bij_wie:           "text_mm1fa4bf",
    datum_bezichtiging:"date_mm1fs4t7",
    adres_klant:       "text_mm1f7fzh",
    opmerkingen:       "text_mm1f4g3q",
    terugzetten:       "boolean_mm1nne68",
    email_makelaar:    "text_mm1n99ky",
  };

  const getCol = (cols, id) =>
    cols.find(c => c.id === id)?.text || "";

  try {
    // ── 1. KOLOMMEN DEBUG ──────────────────────────────────────────────
    if (action === "get_columns") {
      const result = await mondayFetch(`
        query ($boardId: ID!) {
          boards(ids: [$boardId]) {
            name
            columns { id title type }
          }
        }
      `, { boardId: data.board_id });
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    // ── 2. LEADS OPHALEN ───────────────────────────────────────────────
    if (action === "get_leads") {
      const result = await mondayFetch(`
        query ($boardId: ID!) {
          boards(ids: [$boardId]) {
            items_page(limit: 50) {
              items {
                id
                name
                column_values { id text value }
              }
            }
          }
        }
      `, { boardId: data.board_id });

      const items = result?.data?.boards?.[0]?.items_page?.items || [];
      const leads = items.map(item => {
        const cols = item.column_values || [];
        return {
          id: item.id,
          naam: item.name,
          telefoon:  getCol(cols, COL.telefoon),
          email:     getCol(cols, COL.email),
          adres:     getCol(cols, COL.bezichtigd_adres),
          status:    getCol(cols, COL.status),
          datum:     getCol(cols, COL.datum_ontvangen),
          adres_klant: getCol(cols, COL.adres_klant),
          bij_wie:   getCol(cols, COL.bij_wie),
          warme_lead: getCol(cols, COL.warme_lead),
          opmerkingen: getCol(cols, COL.opmerkingen),
        };
      });

      return { statusCode: 200, headers, body: JSON.stringify({ leads }) };
    }

    // ── 3. STATUS UPDATE ───────────────────────────────────────────────
    if (action === "update_status") {
      const { item_id, board_id, status } = data;

      const statusLabels = {
        bereikt_ja:           "Bereikt",
        bereikt_later:        "Bel terug",
        niet_bereikbaar:      "Niet bereikbaar",
        wellicht_later:       "Wellicht later",
        niet_geinteresseerd:  "Niet geïnteresseerd",
        voicemail:            "Voicemail",
      };

      const result = await mondayFetch(`
        mutation ($itemId: ID!, $boardId: ID!, $value: JSON!) {
          change_column_value(
            item_id: $itemId
            board_id: $boardId
            column_id: "color_mm1f9atj"
            value: $value
          ) { id }
        }
      `, {
        itemId: item_id,
        boardId: board_id,
        value: JSON.stringify({ label: statusLabels[status] || status }),
      });

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
