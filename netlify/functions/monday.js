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
      const { board_id, makelaar_naam, makelaar_email } = data;

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

      const leads = items.map(item => {
        const cols = item.column_values || [];

        // Bestaande velden
        const emailMakelaar = cols.find(c => c.id === 'text_mm1n99ky')?.text || '';
        const boardAfkomstig = cols.find(c => c.id === 'text_mm1mpcr0')?.text || '';

        // NIEUWE velden van leadpool round-robin
        const toegewezenAan = cols.find(c => c.id === 'text_mm2rfv9v')?.text || '';
        const emailToegewezen = cols.find(c => c.id === 'text_mm2r2f05')?.text || '';
        const toegewezenOp = cols.find(c => c.id === 'date_mm2rm4mg')?.text || '';
        const leadStatus = cols.find(c => c.id === 'color_mm2rne17')?.text || '';
        const afspraakOp = cols.find(c => c.id === 'date_mm2r1yem')?.text || '';
        const dealOp = cols.find(c => c.id === 'date_mm2r29y4')?.text || '';
        const belpogingen = cols.find(c => c.id === 'numeric_mm2rxahc')?.text || '0';

        // Bron bepalen: leadpool als toegewezen, anders eigen
        const bron = toegewezenAan ? 'leadpool' : 'eigen';

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
          board_afkomstig:    boardAfkomstig,
          // NIEUW: leadpool velden
          toegewezen_aan:     toegewezenAan,
          email_toegewezen:   emailToegewezen,
          toegewezen_op:      toegewezenOp,
          lead_status:        leadStatus,
          afspraak_op:        afspraakOp,
          deal_op:            dealOp,
          bron:               bron,
          belpogingen:        parseInt(belpogingen) || 0,
        };
      }).filter(lead => {
        // Sluit afgehandelde leadpool-leads uit (Lost en Deal verdwijnen uit de lijst)
        if (lead.lead_status === 'Lost' || lead.lead_status === 'Deal') return false;

        // Geen filter = alle leads
        if (!makelaar_naam && !makelaar_email) return true;

        const naam = (makelaar_naam || '').toLowerCase();
        const voornaam = naam.split(' ')[0];
        const email = (makelaar_email || '').toLowerCase();

        // Match op leadpool toewijzing (NIEUW)
        if (email && lead.email_toegewezen.toLowerCase() === email) return true;
        if (voornaam && lead.toegewezen_aan.toLowerCase().includes(voornaam)) return true;

        // Match op eigen bellijst (BESTAAND)
        const board = lead.board_afkomstig.toLowerCase();
        const emailM = lead.email_makelaar.toLowerCase();
        if (board && board.includes(voornaam)) return true;
        if (emailM && emailM.includes(voornaam)) return true;

        return false;
      });

      return { statusCode: 200, headers, body: JSON.stringify({ leads }) };
    }
    // ── LEADPOOL STATUS UPDATE (voor ontvangende makelaar) ──────────────
    if (action === "update_lead_status") {
      const { item_id, lead_status } = data;
      if (!item_id || !lead_status) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "item_id en lead_status verplicht" }) };
      }

      const vandaag = new Date().toISOString().split('T')[0];
      const columnValues = {
        color_mm2rne17: { label: lead_status },   // Lead status
      };

      // Bij Afspraak: vul ook 'Afspraak op d.d.'
      if (lead_status === 'Afspraak') {
        columnValues.date_mm2r1yem = { date: vandaag };
      }
      // Bij Deal: vul ook 'Deal op datum' (komt later via fase 3, maar alvast)
      if (lead_status === 'Deal') {
        columnValues.date_mm2r29y4 = { date: vandaag };
      }

      // Bij Niet bereikt: belpogingen +1
      // (Niet bereikt = blijft op Toegewezen, alleen counter omhoog)
      if (lead_status === 'NietBereikt') {
        // Lees eerst huidige waarde
        const huidigRes = await mondayFetch(`
          query ($itemId: ID!) {
            items(ids: [$itemId]) {
              column_values(ids: ["numeric_mm2rxahc"]) { text }
            }
          }
        `, { itemId: item_id });
        const huidigText = huidigRes?.data?.items?.[0]?.column_values?.[0]?.text || '0';
        const huidig = parseInt(huidigText) || 0;

        // Status blijft Toegewezen, alleen belpogingen omhoog
        const nieuweTeller = huidig + 1;
        await mondayFetch(`
          mutation ($itemId: ID!, $columnValues: JSON!) {
            change_multiple_column_values(
              item_id: $itemId
              board_id: 5093190545
              column_values: $columnValues
            ) { id }
          }
        `, {
          itemId: item_id,
          columnValues: JSON.stringify({
            numeric_mm2rxahc: String(nieuweTeller),
            // status NIET wijzigen — blijft Toegewezen
          }),
        });

        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ ok: true, belpogingen: nieuweTeller, lead_status: 'Toegewezen' }),
        };
      }

      // Anders: status updaten + eventueel afspraakdatum
      await mondayFetch(`
        mutation ($itemId: ID!, $columnValues: JSON!) {
          change_multiple_column_values(
            item_id: $itemId
            board_id: 5093190545
            column_values: $columnValues
          ) { id }
        }
      `, {
        itemId: item_id,
        columnValues: JSON.stringify(columnValues),
      });

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ ok: true, lead_status }),
      };
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

    // ── ARCHIVEREN: zet 'Archiefstatus' boolean op true voor bezichtiging ─────
    if (action === "archiveer_bezichtiging") {
      const { item_id } = data;
      const BOARD_ID = "5093190482"; // Bezichtigingen-board

      // Zoek de Archiefstatus kolom op naam (robuust tegen ID-wijzigingen)
      const colResult = await mondayFetch(`
        query ($boardId: ID!) {
          boards(ids: [$boardId]) { columns { id title type } }
        }
      `, { boardId: BOARD_ID });

      const cols = colResult?.data?.boards?.[0]?.columns || [];
      const archiefCol = cols.find(c =>
        (c.title || '').toLowerCase().includes('archief') &&
        (c.type === 'checkbox' || c.type === 'boolean')
      );

      if (!archiefCol) {
        return {
          statusCode: 500,
          headers,
          body: JSON.stringify({ error: "Archiefstatus-kolom niet gevonden op het bezichtigingen-board" })
        };
      }

      const result = await mondayFetch(`
        mutation ($itemId: ID!, $boardId: ID!, $colId: String!, $value: JSON!) {
          change_column_value(
            item_id: $itemId
            board_id: $boardId
            column_id: $colId
            value: $value
          ) { id }
        }
      `, {
        itemId: item_id,
        boardId: BOARD_ID,
        colId: archiefCol.id,
        value: JSON.stringify({ checked: "true" }),
      });

      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, kolom: archiefCol.id, result }) };
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

      // Eerst: zoek de Archiefstatus-kolom-ID (via naam, zodat we niet hard-coderen)
      const colResult = await mondayFetch(`
        query {
          boards(ids: [5093190482]) { columns { id title type } }
        }
      `);
      const colsAll = colResult?.data?.boards?.[0]?.columns || [];
      const archiefCol = colsAll.find(c =>
        (c.title || '').toLowerCase().includes('archief') &&
        (c.type === 'checkbox' || c.type === 'boolean')
      );
      const archiefColId = archiefCol?.id || null;

      const result = await mondayFetch(`
        query {
          boards(ids: [5093190482]) {
            items_page(limit: 100) {
              items { id name column_values { id text value } }
            }
          }
        }
      `);
      const items = result?.data?.boards?.[0]?.items_page?.items || [];
      const bezichtigingen = items.map(item => {
        const cols = item.column_values || [];
        const get = (id) => cols.find(c => c.id === id)?.text || '';
        const getVal = (id) => {
          const raw = cols.find(c => c.id === id)?.value;
          try { return raw ? JSON.parse(raw) : null; } catch { return null; }
        };

        // Datum + tijdstip uit value JSON
        const datumVal = getVal('date_mm1fn58e');
        const datum = datumVal?.date || get('date_mm1fn58e');
        const tijdstip = datumVal?.time ? datumVal.time.substring(0, 5) : null;

        // Archiefstatus checkbox waarde — true als gearchiveerd
        const gearchiveerd = archiefColId
          ? (get(archiefColId) === 'true' || get(archiefColId) === 'v')
          : false;

        return {
          id:       item.id,
          naam:     item.name,
          adres:    get('text_mm1ff7f1'),
          makelaar: get('text_mm1f3x0n'),
          datum,
          tijdstip,
          telefoon: get('phone_mm1fjavy'),
          email:    get('email_mm1fm8b7'),
          niet_naar_pool: get('boolean_mm1s4qcy') === 'true',
          doorgegeven:    get('boolean_mm2q35j3') === 'true',
          gearchiveerd,
          feedback: get('text_mm1fy05p'), // Adres klant kolom hergebruiken voor feedback
          in_pool:  false,
        };
      }).filter(b => {
        if (b.gearchiveerd) return false;       // gearchiveerde bezichtigingen verbergen
        if (b.niet_naar_pool) return false;
        if (b.doorgegeven) return false;
        if (!makelaar_naam) return true;
        return b.makelaar?.toLowerCase().includes(makelaar_naam.split(' ')[0].toLowerCase());
      });
      return { statusCode: 200, headers, body: JSON.stringify({ bezichtigingen }) };
    }

    // ── PUSH NAAR LEADPOOL ─────────────────────────────────────────────
    // ── ROUND-ROBIN: WIJS LEAD TOE AAN AANGEVINKTE MAKELAAR ─────────────
    if (action === "assign_makelaar") {
      const { item_id } = data;
      if (!item_id) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "item_id ontbreekt" }) };
      }

      // 1. Haal aangevinkte makelaars op uit Meedoen Leadpool
      const mResult = await mondayFetch(`
        query {
          boards(ids: [5093235823]) {
            items_page(limit: 50) {
              items { name column_values { id text } }
            }
          }
        }
      `);
      const items = mResult?.data?.boards?.[0]?.items_page?.items || [];
      const makelaars = items
        .map(item => ({
          naam: item.name,
          email: item.column_values.find(c => c.id === 'text_mm1nxwsn')?.text || '',
          meedoen: item.column_values.find(c => c.id === 'boolean_mm1g4fwm')?.text || '',
          vakantie: item.column_values.find(c => c.id === 'timerange_mm1gj38w')?.text || '',
        }))
        .filter(m => (m.meedoen === 'true' || m.meedoen === 'v') && m.email);

      if (makelaars.length === 0) {
        return { statusCode: 200, headers, body: JSON.stringify({ ok: false, reden: "Geen aangevinkte makelaars" }) };
      }

      // 2. Lees teller uit Make data-store
      const MAKE_API = process.env.MAKE_API_TOKEN;
      const DS_ID = 117681; // Leadpool RR teller
      const tellerRes = await fetch(`https://eu1.make.com/api/v2/data-stores/${DS_ID}/data/counter`, {
        headers: { 'Authorization': `Token ${MAKE_API}` }
      });
      const tellerJson = await tellerRes.json();
      const teller = tellerJson?.record?.data?.teller || 0;

      // 3. Round-robin: pak de juiste makelaar
      const index = teller % makelaars.length;
      const gekozen = makelaars[index];
      const vandaag = new Date().toISOString().split('T')[0];

      // 4. Update Leadpool item: toegewezen aan, email, datum, status
      await mondayFetch(`
        mutation ($itemId: ID!, $columnValues: JSON!) {
          change_multiple_column_values(
            item_id: $itemId
            board_id: 5093190545
            column_values: $columnValues
          ) { id }
        }
      `, {
        itemId: item_id,
        columnValues: JSON.stringify({
          text_mm2rfv9v: gekozen.naam,                          // Toegewezen aan
          text_mm2r2f05: gekozen.email,                         // Email toegewezen
          date_mm2rm4mg: { date: vandaag },                     // Toegewezen op datum
          color_mm2rne17: { label: "Toegewezen" },              // Lead status
        }),
      });

      // 5. Verhoog teller in Make data-store
      await fetch(`https://eu1.make.com/api/v2/data-stores/${DS_ID}/data/counter`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Token ${MAKE_API}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ data: { teller: teller + 1 } }),
      });

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          ok: true,
          gekozen: gekozen.naam,
          email: gekozen.email,
          aantal_makelaars: makelaars.length,
          oude_teller: teller,
          nieuwe_teller: teller + 1,
        }),
      };
    }if (action === "push_naar_pool") {
      const { item_id } = data;
      // Stap 1: trigger de button om lead naar Leadpool bord te sturen
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
      // Stap 2: markeer als doorgegeven zodat hij uit de lijst van gevende makelaar verdwijnt
      await mondayFetch(`
        mutation ($itemId: ID!) {
          change_column_value(
            item_id: $itemId
            board_id: 5093190482
            column_id: "boolean_mm2q35j3"
            value: "{\"checked\":\"true\"}"
          ) { id }
        }
      `, { itemId: item_id });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, result }) };
    }

    // ── FEEDBACK OPSLAAN IN BEZICHTIGINGEN BORD ───────────────────────
    if (action === "sla_feedback_op") {
      const { item_id, feedback_tekst } = data;
      const result = await mondayFetch(`
        mutation ($itemId: ID!, $value: JSON!) {
          change_column_value(
            item_id: $itemId
            board_id: 5093190482
            column_id: "text_mm1fy05p"
            value: $value
          ) { id }
        }
      `, {
        itemId: item_id,
        value: JSON.stringify(feedback_tekst),
      });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
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
