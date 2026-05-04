// ── MAPPING: Boards-label uit Meedoen Leadpool → bellijst-board-ID ────
// De "Boards" kolom op het Meedoen Leadpool board (5093235823) bevat per
// makelaar een uniek label (bv. "Bellijst_MauritsvL"). Dat label wordt
// hier vertaald naar het echte Monday board-ID. Bij nieuwe makelaars:
// regel hier toevoegen + label invullen op het Meedoen-board.
const BELLIJST_LABELS = {
  'Bellijst_Ton':       '5095598157',
  'Bellijst_Mathias':   '5093235114',  // Mathias Elias (1 t)
  'Bellijst_Maurits':   '5093529769',  // Maurits Rodermond
  'Bellijst_MauritsvL': '5095568381',  // Maurits van Leeuwen
  'Bellijst_Rogier':    '5095567991',
  'Bellijst_Jori':      '5095568083',
  'Bellijst_Anthonie':  '5095568346',
  'Bellijst_Wilma':     '5095568404',
  'Bellijst_Pelle':     '5095568419',
  // Filipe en Gert-Jan ('t Gooi-makelaars) verwijderd — zie isMVAMakelaar() filter
  'Bellijst_Jan-Jaap':  '5095568639',
};

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

  // Filter: alleen MVA Amsterdam-makelaars. 't Gooi-makelaars (Filipe Bataglia,
  // Gert-Jan) worden uitgesloten — die werken in dezelfde Monday maar hun
  // bezichtigingen zijn voor MVA Bellijst niet relevant.
  const isMVAMakelaar = (naam) => {
    const n = (naam || '').toLowerCase();
    if (n.includes('filipe') || n.includes('bataglia')) return false;
    if (n.includes('gert-jan') || n.includes('gertjan') || n.includes('gert jan')) return false;
    return true;
  };

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
      const { board_id, makelaar_naam, makelaar_email, bron } = data;

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

        // BRON 'eigen' = eigen bellijst-board: hele board is per definitie van
        // deze makelaar, geen extra filter nodig (behalve Lost/Deal hierboven).
        if (bron === 'eigen') return true;

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

    // ── EIGEN BELLIJST-BOARD OPHALEN (voor login-flow) ──────────────────
    // Geeft het bellijst-board-ID terug van een makelaar, op basis van email
    // (of naam als fallback). Wordt gebruikt door de app bij login om de
    // "Mijn leads"-tab te kunnen vullen. Lookup verloopt via dezelfde route
    // als push_naar_eigen_bellijst: Meedoen-board → Boards-label → BELLIJST_LABELS.
    if (action === "get_eigen_bellijst_board") {
      const { makelaar_naam, makelaar_email } = data;
      if (!makelaar_naam && !makelaar_email) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "makelaar_naam of makelaar_email verplicht" }) };
      }

      const meedoenResult = await mondayFetch(`
        query {
          boards(ids: [5093235823]) {
            items_page(limit: 50) {
              items { name column_values { id text } }
            }
          }
        }
      `);
      const meedoenItems = meedoenResult?.data?.boards?.[0]?.items_page?.items || [];

      const emailLower = (makelaar_email || '').toLowerCase();
      const naamLower = (makelaar_naam || '').toLowerCase();
      const voornaam = naamLower.split(' ')[0];

      let gevonden = null;
      if (emailLower) {
        gevonden = meedoenItems.find(m => {
          const e = m.column_values.find(c => c.id === 'text_mm1nxwsn')?.text || '';
          return e.toLowerCase() === emailLower;
        });
      }
      if (!gevonden && naamLower) {
        gevonden = meedoenItems.find(m => m.name.toLowerCase() === naamLower);
      }
      if (!gevonden && voornaam) {
        const matches = meedoenItems.filter(m => m.name.toLowerCase().split(' ')[0] === voornaam);
        if (matches.length === 1) gevonden = matches[0];
      }

      if (!gevonden) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ ok: false, reden: "Makelaar niet gevonden in Meedoen-board" })
        };
      }

      const boardLabel = gevonden.column_values.find(c => c.id === 'text_mm1gbj3q')?.text || '';
      const boardId = BELLIJST_LABELS[boardLabel] || null;

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          ok: !!boardId,
          board_id: boardId,
          board_label: boardLabel,
          makelaar: gevonden.name,
        }),
      };
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

    // ── MARKEER ALS AFGEHANDELD: zet niet_naar_pool=true op bezichtigingen-board ─────
    // Persistente status zodat de kaart na refresh uit de actieve gevende
    // lijst verdwijnt en in 'Zelf bellen'/'Afgehandeld' filter terugkomt.
    if (action === "markeer_afgehandeld") {
      const { item_id } = data;
      const result = await mondayFetch(`
        mutation ($itemId: ID!) {
          change_column_value(
            item_id: $itemId
            board_id: 5093190482
            column_id: "boolean_mm1s4qcy"
            value: "{\"checked\":\"true\"}"
          ) { id }
        }
      `, { itemId: item_id });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, result }) };
    }

    // ── ARCHIVEREN: zet 'Archiefstatus' boolean op true voor bezichtiging ─────
    if (action === "archiveer_bezichtiging") {      const { item_id, archiveer } = data;
      // archiveer: true (default) = naar archief, false = herstel uit archief
      const naarArchief = archiveer !== false;
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

      // Checkbox aan = archief, leeg = uit archief
      const checkboxValue = naarArchief ? { checked: "true" } : {};

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
        value: JSON.stringify(checkboxValue),
      });

      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, kolom: archiefCol.id, gearchiveerd: naarArchief, result }) };
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
        .filter(m => isMVAMakelaar(m.naam))
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
        .filter(m => m.meedoen === 'true' || m.meedoen === 'v')
        .filter(m => isMVAMakelaar(m.naam));

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
        // 2026-05-01: Monday slaat tijden op als UTC ('10:00:00' = 12:00 Amsterdam zomertijd).
        // We converteren naar Europe/Amsterdam zodat de bellijst de juiste lokale tijd toont.
        // toLocaleTimeString met timeZone handelt zomertijd/wintertijd automatisch af.
        const datumVal = getVal('date_mm1fn58e');
        const datum = datumVal?.date || get('date_mm1fn58e');
        let tijdstip = null;
        if (datumVal?.time && datumVal?.date) {
          try {
            const utcDate = new Date(`${datumVal.date}T${datumVal.time}Z`);
            tijdstip = utcDate.toLocaleTimeString('nl-NL', {
              timeZone: 'Europe/Amsterdam',
              hour: '2-digit',
              minute: '2-digit',
            });
          } catch {
            // Fallback bij ongeldige datum/tijd: behoud oude gedrag
            tijdstip = datumVal.time.substring(0, 5);
          }
        }

        // Archiefstatus checkbox waarde — true als gearchiveerd
        const gearchiveerd = archiefColId
          ? (get(archiefColId) === 'true' || get(archiefColId) === 'v')
          : false;

        // Feedback parsen — nieuw formaat is JSON {k,o,t}, oud formaat is losse tekst
        const feedbackRaw = get('text_mm1fy05p');
        let feedbackKeys = '';
        let feedbackOpmerking = '';
        if (feedbackRaw) {
          try {
            const parsed = JSON.parse(feedbackRaw);
            if (parsed && typeof parsed === 'object' && 'k' in parsed) {
              feedbackKeys      = parsed.k || '';
              feedbackOpmerking = parsed.o || '';
            } else {
              // Onbekende JSON-structuur — laat staan in opmerking als info
              feedbackOpmerking = feedbackRaw;
            }
          } catch {
            // Oud formaat: losse tekst zonder JSON
            // We weten geen keys, dus alleen tekst tonen als opmerking
            feedbackOpmerking = feedbackRaw;
          }
        }

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
          feedback:  feedbackKeys,           // comma-separated keys, bv. "serieus,verkoop"
          opmerking: feedbackOpmerking,      // ruwe opmerking-tekst
          in_pool:  false,
        };
      }).filter(b => {
        if (b.gearchiveerd) return false;       // gearchiveerde bezichtigingen verbergen
        if (!isMVAMakelaar(b.makelaar)) return false;
        if (!makelaar_naam) return true;
        return b.makelaar?.toLowerCase().includes(makelaar_naam.split(' ')[0].toLowerCase());
      }).map(b => {
        // Persistente actie-status afleiden uit Monday-velden zodat de app na
        // refresh weet of een lead naar pool is gestuurd, zelf belt of afgehandeld.
        // 'doorgegeven=true' betekent: lead is naar de pool gestuurd
        // 'niet_naar_pool=true' (zonder doorgegeven) betekent: zelf bellen of afgehandeld
        let actie_status = '';
        if (b.doorgegeven)         actie_status = 'pool';
        else if (b.niet_naar_pool) actie_status = 'zelf'; // best-guess: niet-naar-pool zonder pool = zelf
        // 'afgehandeld' kan momenteel niet onderscheiden worden van 'zelf' op basis van Monday-velden;
        // daar gebruiken we momenteel ook niet_naar_pool. Verbetering voor later.
        b.actie_status = actie_status;
        // in_pool blijft true voor backwards compat met bestaande UI-code
        b.in_pool = (actie_status === 'pool');
        return b;
      });
      return { statusCode: 200, headers, body: JSON.stringify({ bezichtigingen }) };
    }

    // ── GEARCHIVEERDE BEZICHTIGINGEN OPHALEN ──────────────────────────
    // Net als get_bezichtigingen maar omgekeerde filter: ALLEEN gearchiveerde
    // tonen voor de huidige makelaar. Voor het Archief-filter in de app.
    if (action === "get_gearchiveerde_bezichtigingen") {
      const { makelaar_naam } = data;
      const BOARD_ID = "5093190482";

      // Archiefstatus kolom-ID vinden
      const colResult = await mondayFetch(`
        query { boards(ids: [${BOARD_ID}]) { columns { id title type } } }
      `);
      const colsAll = colResult?.data?.boards?.[0]?.columns || [];
      const archiefCol = colsAll.find(c =>
        (c.title || '').toLowerCase().includes('archief') &&
        (c.type === 'checkbox' || c.type === 'boolean')
      );
      const archiefColId = archiefCol?.id || null;

      const result = await mondayFetch(`
        query {
          boards(ids: [${BOARD_ID}]) {
            items_page(limit: 200) {
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

        const datumVal = getVal('date_mm1fn58e');
        const datum = datumVal?.date || get('date_mm1fn58e');
        let tijdstip = null;
        if (datumVal?.time && datumVal?.date) {
          try {
            const utcDate = new Date(`${datumVal.date}T${datumVal.time}Z`);
            tijdstip = utcDate.toLocaleTimeString('nl-NL', {
              timeZone: 'Europe/Amsterdam',
              hour: '2-digit',
              minute: '2-digit',
            });
          } catch {
            tijdstip = datumVal.time.substring(0, 5);
          }
        }

        const gearchiveerd = archiefColId
          ? (get(archiefColId) === 'true' || get(archiefColId) === 'v')
          : false;

        // Feedback parsen (zelfde als get_bezichtigingen)
        const feedbackRaw = get('text_mm1fy05p');
        let feedbackKeys = '';
        let feedbackOpmerking = '';
        if (feedbackRaw) {
          try {
            const parsed = JSON.parse(feedbackRaw);
            if (parsed && typeof parsed === 'object' && 'k' in parsed) {
              feedbackKeys      = parsed.k || '';
              feedbackOpmerking = parsed.o || '';
            } else {
              feedbackOpmerking = feedbackRaw;
            }
          } catch {
            feedbackOpmerking = feedbackRaw;
          }
        }

        return {
          id:       item.id,
          naam:     item.name,
          adres:    get('text_mm1ff7f1'),
          makelaar: get('text_mm1f3x0n'),
          datum,
          tijdstip,
          telefoon: get('phone_mm1fjavy'),
          email:    get('email_mm1fm8b7'),
          gearchiveerd,
          feedback:  feedbackKeys,
          opmerking: feedbackOpmerking,
        };
      }).filter(b => {
        if (!b.gearchiveerd) return false;     // ALLEEN gearchiveerd
        if (!isMVAMakelaar(b.makelaar)) return false;
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
        .filter(m => (m.meedoen === 'true' || m.meedoen === 'v') && m.email)
        .filter(m => isMVAMakelaar(m.naam));

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

    // ── PUSH NAAR EIGEN BELLIJST (Zelf bellen flow) ─────────────────────
    // Slaat de Round Robin volledig over: maakt direct een item aan op het
    // bellijst-board van de gevende makelaar. Mapping verloopt via de
    // "Boards"-kolom op het Meedoen Leadpool board (text_mm1gbj3q), dat
    // label wordt vertaald naar een board-ID via BELLIJST_LABELS bovenin.
    //
    // Waarom via Meedoen-board: voornaam-mapping rammelt zodra er twee
    // makelaars dezelfde voornaam hebben (Maurits R. + Maurits vL.). De
    // labels op het Meedoen-board zijn uniek en al beheerd in Monday.
    if (action === "push_naar_eigen_bellijst") {
      const { item_id, makelaar_naam, makelaar_email } = data;
      if (!item_id || (!makelaar_naam && !makelaar_email)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "item_id en makelaar_naam (of makelaar_email) verplicht" }) };
      }

      // 1. Haal Meedoen-board op om de juiste makelaar te vinden
      const meedoenResult = await mondayFetch(`
        query {
          boards(ids: [5093235823]) {
            items_page(limit: 50) {
              items { name column_values { id text } }
            }
          }
        }
      `);
      const meedoenItems = meedoenResult?.data?.boards?.[0]?.items_page?.items || [];

      // Match: eerst op email (uniek), anders op volledige naam, anders op voornaam
      const emailLower = (makelaar_email || '').toLowerCase();
      const naamLower = (makelaar_naam || '').toLowerCase();
      const voornaam = naamLower.split(' ')[0];

      let gevonden = null;
      if (emailLower) {
        gevonden = meedoenItems.find(m => {
          const e = m.column_values.find(c => c.id === 'text_mm1nxwsn')?.text || '';
          return e.toLowerCase() === emailLower;
        });
      }
      if (!gevonden && naamLower) {
        gevonden = meedoenItems.find(m => m.name.toLowerCase() === naamLower);
      }
      if (!gevonden && voornaam) {
        // Voorzichtig: alleen matchen als exact één makelaar deze voornaam heeft
        const matches = meedoenItems.filter(m => m.name.toLowerCase().split(' ')[0] === voornaam);
        if (matches.length === 1) gevonden = matches[0];
      }

      if (!gevonden) {
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ error: `Geen makelaar gevonden in Meedoen-board voor: ${makelaar_naam || makelaar_email}` })
        };
      }

      // 2. Lees Boards-label en vertaal naar board-ID
      const boardLabel = gevonden.column_values.find(c => c.id === 'text_mm1gbj3q')?.text || '';
      const targetBoardId = BELLIJST_LABELS[boardLabel];
      if (!targetBoardId) {
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ error: `Geen bellijst-board-ID voor label: "${boardLabel}" (makelaar: ${gevonden.name}). Voeg toe aan BELLIJST_LABELS.` })
        };
      }

      // 3. Haal de bezichtiging-data op zodat we 'm kunnen kopiëren
      const bezResult = await mondayFetch(`
        query ($itemId: ID!) {
          items(ids: [$itemId]) {
            id
            name
            column_values { id text value }
          }
        }
      `, { itemId: item_id });

      const bezItem = bezResult?.data?.items?.[0];
      if (!bezItem) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: "Bezichtiging niet gevonden" }) };
      }

      const bezCols = bezItem.column_values || [];
      const bezGet = (id) => bezCols.find(c => c.id === id)?.text || '';
      const bezGetVal = (id) => {
        const raw = bezCols.find(c => c.id === id)?.value;
        try { return raw ? JSON.parse(raw) : null; } catch { return null; }
      };

      // Bezichtigingen-board kolom-IDs (zie get_bezichtigingen voor referentie)
      const naam        = bezItem.name;
      const adres       = bezGet('text_mm1ff7f1');
      const datumVal    = bezGetVal('date_mm1fn58e');
      const datum       = datumVal?.date || bezGet('date_mm1fn58e');
      const telefoon    = bezGet('phone_mm1fjavy');
      const email       = bezGet('email_mm1fm8b7');

      // 4. Maak nieuw item aan op het bellijst-board
      // Kolom-IDs gespiegeld aan get_leads structuur. NB: bellijst-boards
      // zijn gekopieerd van Mathias' board en delen dezelfde kolomstructuur.
      const nieuweKolommen = {
        phone_mm1fzq2g: telefoon ? { phone: telefoon, countryShortName: "NL" } : null,
        email_mm1fnwvn: email ? { email: email, text: email } : null,
        text_mm1frktj:  adres,                     // Adres
        text_mm1fa4bf:  gevonden.name,             // Bij wie (gevende makelaar — uit Meedoen)
        date_mm1fs4t7:  datum ? { date: datum } : null, // Datum bezichtiging
        text_mm1mpcr0:  boardLabel,                // Board afkomstig (gebruik label)
      };

      // Verwijder null/lege waarden — Monday API klaagt anders
      const opgeschoond = Object.fromEntries(
        Object.entries(nieuweKolommen).filter(([_, v]) => v !== null && v !== '')
      );

      const createResult = await mondayFetch(`
        mutation ($boardId: ID!, $itemName: String!, $columnValues: JSON!) {
          create_item(
            board_id: $boardId
            item_name: $itemName
            column_values: $columnValues
          ) { id }
        }
      `, {
        boardId: targetBoardId,
        itemName: naam,
        columnValues: JSON.stringify(opgeschoond),
      });

      // 5. Markeer de bezichtiging als 'niet_naar_pool' (= zelf bellen).
      // Dit onderscheidt 'zelf bellen' van 'naar pool' — beide verbergen de
      // bezichtiging van de gevende makelaar, maar de status verschilt zodat
      // de app weet welke filter ('Naar pool' / 'Zelf bellen') ze moet tonen.
      await mondayFetch(`
        mutation ($itemId: ID!) {
          change_column_value(
            item_id: $itemId
            board_id: 5093190482
            column_id: "boolean_mm1s4qcy"
            value: "{\"checked\":\"true\"}"
          ) { id }
        }
      `, { itemId: item_id });

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          ok: true,
          gevonden_makelaar: gevonden.name,
          board_label: boardLabel,
          target_board: targetBoardId,
          nieuw_item: createResult?.data?.create_item?.id || null,
        }),
      };
    }
    if (action === "sla_feedback_op") {
      const { item_id, feedback, feedback_tekst, opmerking } = data;
      // Sla op als JSON zodat we bij teruglezen zowel keys als opmerking apart hebben.
      // Voor leesbaarheid in Monday-UI: structureer als
      //   {"k":"serieus,verkoop","o":"klant zoekt 4-kamer","t":"🔥 ... — ..."}
      // Achterwaarts compatibel: oude data zonder JSON-structuur wordt als losse tekst gelezen.
      const payload = JSON.stringify({
        k: feedback || '',                    // keys, bv. "serieus,verkoop"
        o: opmerking || '',                   // ruwe opmerking
        t: feedback_tekst || '',              // leesbare tekst (voor Monday-UI gebruikers)
      });
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
        value: JSON.stringify(payload),
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
