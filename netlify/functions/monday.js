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

  const getCol = (cols, id) =>
    cols.find(c => c.id === id)?.text || "";

  try {
    // ── DEBUG: KOLOMMEN OPHALEN ────────────────────────────────────────
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

    // ── LEADS OPHALEN ─────────────────────────────────────────────────
    if (action === "get_leads") {
      const { board_id, makelaar_naam } = data;

      const result = await mondayFetch(`
        query ($boardId: ID!) {
          boards(ids: [$boardId]) {
            items_page(limit: 100) {
              items {
                id
                name
                column_values { id text value }
              }
            }
          }
        }
      `, { boardId: board_id });

      const items = result?.data?.boards?.[0]?.items_page?.items || [];

      // Haal alle kolom-waarden op als één platte map
      const leads = items.map(item => {
        const cols = item.column_values || [];
        const colMap = {};
        cols.forEach(c => { colMap[c.id] = c.text || ''; });

        // Zoek "board afkomstig" kolom (bevat Bellijst_Maurits / Bellijst_Matthias)
        const boardAfkomstig = cols.find(c =>
          c.text && (c.text.includes('Bellijst') || c.text.includes('bellijst'))
        )?.text || '';

        // email_makelaar als fallback
        const emailMakelaar = cols.find(c => c.id === 'text_mm1n99ky')?.text || '';

        return {
          id: item.id,
          naam: item.name,
          telefoon:           cols.find(c => c.id === 'phone_mm1fzq2g')?.text || '',
          email:              cols.find(c => c.id === 'email_mm1fnwvn')?.text || '',
          adres:              cols.find(c => c.id === 'text_mm1frktj')?.text || '',
          bij_wie:            cols.find(c => c.id === 'text_mm1fa4bf')?.text || '',
          datum:              cols.find(c => c.id === 'date_mm1f1fw2')?.text || '',
          datum_bezichtiging: cols.find(c => c.id === 'date_mm1fs4t7')?.text || '',
          adres_klant:        cols.find(c => c.id === 'text_mm1f7fzh')?.text || '',
          status:             cols.find(c => c.id === 'color_mm1f9atj')?.text || '',
          warme_lead:         cols.find(c => c.id === 'boolean_mm1fnaay')?.text || '',
          opmerkingen:        cols.find(c => c.id === 'text_mm1f4g3q')?.text || '',
          email_makelaar:     emailMakelaar,
          board_afkomstig:    cols.find(c => c.id === 'text_mm1mpcr0')?.text || boardAfkomstig,
        };
      }).filter(lead => {
        // Filter op makelaar
        if (!makelaar_naam) return true;
        const board = lead.board_afkomstig.toLowerCase();
        const email = lead.email_makelaar.toLowerCase();
        const naam = makelaar_naam.toLowerCase();

        // Match op board naam (Bellijst_Maurits / Bellijst_Matthias)
        if (board && board.includes(naam.split(' ')[0])) return true;
        // Match op email
        if (email && email.includes(naam.split(' ')[0])) return true;
        // Als beide leeg zijn: toon wel (niet-toegewezen leads)
        if (!board && !email) return true;

        return false;
      });

      return { statusCode: 200, headers, body: JSON.stringify({ leads }) };
    }

    // ── STATUS UPDATE ──────────────────────────────────────────────────
    if (action === "update_status") {
      const { item_id, board_id, status } = data;

      const statusLabels = {
        bereikt_ja:          "Bereikt",
        bereikt_later:       "Bel terug",
        niet_bereikbaar:     "Niet bereikbaar",
        wellicht_later:      "Wellicht later",
        niet_geinteresseerd: "Niet geïnteresseerd",
        voicemail:           "Voicemail",
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


    // ── ALLE MAKELAARS (ook gevende, zonder vinkje) ───────────────────
    if (action === "get_alle_makelaars") {
      const result = await mondayFetch(`{
        boards(ids: [5093235823]) {
          items_page(limit: 50) {
            items {
              name
              column_values { id text }
            }
          }
        }
      }`);
      const items = result?.data?.boards?.[0]?.items_page?.items || [];
      const makelaars = items
        .map(item => ({
          naam:  item.name,
          email: item.column_values.find(c => c.id === "text_mm1nxwsn")?.text || "",
          actief: item.column_values.find(c => c.id === "boolean_mm1g4fwm")?.text === "true",
          board:  item.column_values.find(c => c.id === "text_mm1gbj3q")?.text || "",
        }))
        .filter(m => m.email) // alleen makelaars met een emailadres
        .sort((a, b) => a.naam.localeCompare(b.naam));
      return { statusCode: 200, headers, body: JSON.stringify({ makelaars }) };
    }

    // ── ACTIEVE MAKELAARS OPHALEN UIT MEEDOEN LEADPOOL ────────────────
    if (action === "get_makelaars") {
      const result = await mondayFetch(`
        query {
          boards(ids: [5093235823]) {
            items_page(limit: 50) {
              items {
                id
                name
                column_values { id text value }
              }
            }
          }
        }
      `);

      const items = result?.data?.boards?.[0]?.items_page?.items || [];
      const makelaars = items
        .map(item => {
          const cols = item.column_values || [];
          const email     = cols.find(c => c.id === 'text_mm1nxwsn')?.text || '';
          const meedoen   = cols.find(c => c.id === 'boolean_mm1g4fwm')?.text || '';
          const vakantie  = cols.find(c => c.id === 'timerange_mm1gj38w')?.text || '';
          const board     = cols.find(c => c.id === 'text_mm1gbj3q')?.text || '';
          return { naam: item.name, email, meedoen, vakantie, board };
        })
        // Alleen actieve makelaars (meedoen = true, niet op vakantie)
        .filter(m => m.meedoen === 'true' || m.meedoen === 'v');

      return { statusCode: 200, headers, body: JSON.stringify({ makelaars }) };
    }

    // ── BEZICHTIGINGEN OPHALEN (gevende makelaar) ─────────────────────
    if (action === "get_bezichtigingen") {
      const { makelaar_naam } = data;
      const result = await mondayFetch(`
        query {
          boards(ids: [5093190482]) {
            items_page(limit: 100) {
              items { id name column_values { id text } }
            }
          }
        }
      `);
      const items = result?.data?.boards?.[0]?.items_page?.items || [];
      const bezichtigingen = items.map(item => {
        const cols = item.column_values || [];
        const get = (id) => cols.find(c => c.id === id)?.text || '';
        return {
          id:       item.id,
          naam:     item.name,
          adres:    get('text_mm1ff7f1'),
          makelaar: get('text_mm1f3x0n'),
          datum:    get('date_mm1fn58e'),
          telefoon: get('phone_mm1fjavy'),
          email:    get('email_mm1fm8b7'),
          niet_naar_pool: get('boolean_mm1s4qcy') === 'true',
          in_pool:  false, // button kolom is niet leesbaar
        };
      }).filter(b => {
        // Filter uit wat niet naar de pool mag
        if (b.niet_naar_pool) return false;
        if (!makelaar_naam) return true;
        return b.makelaar?.toLowerCase().includes(makelaar_naam.split(' ')[0].toLowerCase());
      });
      return { statusCode: 200, headers, body: JSON.stringify({ bezichtigingen }) };
    }

    // ── PUSH NAAR LEADPOOL ─────────────────────────────────────────────
    if (action === "push_naar_pool") {
      const { item_id } = data;
      const result = await mondayFetch(`
        mutation ($itemId: ID!) {
          change_column_value(
            item_id: $itemId
            board_id: 5093190482
            column_id: "button_mm1fnwa0"
            value: "{}"
          ) { id }
        }
      `, { itemId: item_id });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, result }) };
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
