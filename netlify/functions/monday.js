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

  const mondayFetch = async (query, variables = {}) => {
    const token = MONDAY_TOKEN.startsWith('Bearer ') ? MONDAY_TOKEN : `Bearer ${MONDAY_TOKEN}`;
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

  try {
    // ── 1. HAAL LEADS OP VOOR EEN MAKELAAR ────────────────────────────
    if (action === "get_leads") {
      const { board_id } = data;

      const query = `
        query ($boardId: ID!) {
          boards(ids: [$boardId]) {
            items_page(limit: 50) {
              items {
                id
                name
                column_values {
                  id
                  text
                  value
                }
              }
            }
          }
        }
      `;

      const result = await mondayFetch(query, { boardId: board_id });
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    // ── 2. UPDATE STATUS VAN EEN LEAD ─────────────────────────────────
    if (action === "update_status") {
      const { item_id, board_id, status } = data;

      // Status kolom waarden (aanpassen aan Roemers board)
      const statusLabels = {
        bereikt_ja: "Bereikt",
        bereikt_later: "Bel terug",
        niet_bereikbaar: "Niet bereikbaar",
        wellicht_later: "Wellicht later",
        niet_geinteresseerd: "Niet geïnteresseerd",
        voicemail: "Voicemail",
      };

      const query = `
        mutation ($itemId: ID!, $boardId: ID!, $value: JSON!) {
          change_column_value(
            item_id: $itemId,
            board_id: $boardId,
            column_id: "status",
            value: $value
          ) {
            id
          }
        }
      `;

      const result = await mondayFetch(query, {
        itemId: item_id,
        boardId: board_id,
        value: JSON.stringify({ label: statusLabels[status] || status }),
      });
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    // ── 3. HAAL KOLOM-IDs OP (debug) ──────────────────────────────────
    if (action === "get_columns") {
      const { board_id } = data;
      const result = await mondayFetch(`
        query ($boardId: ID!) {
          boards(ids: [$boardId]) {
            name
            columns { id title type }
          }
        }
      `, { boardId: board_id });
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
