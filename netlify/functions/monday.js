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

  // Slimme kolom-mapping: zoekt op meerdere mogelijke ID's
  const getColValue = (cols, ...ids) => {
    for (const id of ids) {
      const col = cols.find(c => c.id === id || c.id.toLowerCase().includes(id.toLowerCase()));
      if (col && col.text) return col.text;
    }
    return "";
  };

  try {
    // ── 1. KOLOMMEN OPHALEN (debug) ────────────────────────────────────
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
      const { board_id } = data;

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
      `, { boardId: board_id });

      // Zet ruwe monday items om naar bruikbare lead-objecten
      const items = result?.data?.boards?.[0]?.items_page?.items || [];
      const leads = items.map(item => {
        const cols = item.column_values || [];
        return {
          id: item.id,
          naam: item.name,
          // Probeer meerdere mogelijke kolom-namen
          telefoon: getColValue(cols, "phone", "telefoon", "telefoon_nummer", "mobile", "tel"),
          email: getColValue(cols, "email", "e_mail", "emailadres"),
          adres: getColValue(cols, "bezichtigd_adres", "adres", "address", "text", "text0"),
          status: getColValue(cols, "status", "status4", "lead_status"),
          datum: getColValue(cols, "date", "datum", "datum_ontvangen", "date4"),
          adres_klant: getColValue(cols, "adres_klant", "text1", "text2"),
          // Bewaar ook de ruwe kolommen voor debugging
          _raw: cols.map(c => ({ id: c.id, text: c.text })).filter(c => c.text)
        };
      });

      return { statusCode: 200, headers, body: JSON.stringify({ leads, raw: result }) };
    }

    // ── 3. STATUS UPDATE ───────────────────────────────────────────────
    if (action === "update_status") {
      const { item_id, board_id, status, status_col_id } = data;

      const statusLabels = {
        bereikt_ja: "Bereikt",
        bereikt_later: "Bel terug",
        niet_bereikbaar: "Niet bereikbaar",
        wellicht_later: "Wellicht later",
        niet_geinteresseerd: "Niet geïnteresseerd",
        voicemail: "Voicemail",
      };

      // Gebruik de kolom-ID die we van get_columns hebben gekregen
      const colId = status_col_id || "status";

      const result = await mondayFetch(`
        mutation ($itemId: ID!, $boardId: ID!, $colId: String!, $value: JSON!) {
          change_column_value(
            item_id: $itemId,
            board_id: $boardId,
            column_id: $colId,
            value: $value
          ) { id }
        }
      `, {
        itemId: item_id,
        boardId: board_id,
        colId: colId,
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
