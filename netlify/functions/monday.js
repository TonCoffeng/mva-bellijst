// netlify/functions/monday.js
// ─────────────────────────────────────────────────────────────────────────────
// HYBRIDE: Bezichtigingen-acties → Supabase, Bellijst-acties → Monday (legacy).
//
// Migratie status (6 mei 2026):
//   ✅ Naar Supabase:
//      - get_bezichtigingen
//      - get_gearchiveerde_bezichtigingen
//      - archiveer_bezichtiging
//      - markeer_afgehandeld
//      - push_naar_pool         (incl. Round Robin via toewijzingen-tabel)
//      - push_naar_eigen_bellijst   (zet alleen flag, kopie naar bellijst-board nog Monday)
//      - sla_feedback_op
//
//   ⏳ Nog op Monday (Groep 2 — Bellijst, latere migratie):
//      - get_leads, get_eigen_bellijst_board, update_lead_status
//      - assign_makelaar (oude RR via Make data-store), get_makelaars, get_alle_makelaars
//      - get_columns (debug)
//
// Backwards compatibility: alle response-shapes identiek aan oude versie zodat
// public/index.html ongewijzigd kan blijven.
// ─────────────────────────────────────────────────────────────────────────────

// ── MAPPING: Boards-label uit Meedoen Leadpool → bellijst-board-ID ────
const BELLIJST_LABELS = {
  'Bellijst_Ton':       '5095598157',
  'Bellijst_Mathias':   '5093235114',
  'Bellijst_Maurits':   '5093529769',
  'Bellijst_MauritsvL': '5095568381',
  'Bellijst_Rogier':    '5095567991',
  'Bellijst_Jori':      '5095568083',
  'Bellijst_Anthonie':  '5095568346',
  'Bellijst_Wilma':     '5095568404',
  'Bellijst_Pelle':     '5095568419',
  'Bellijst_Jan-Jaap':  '5095568639',
};

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const MVA_KANTOOR_ID       = 1; // MVA Amsterdam — vast voor nu, multi-tenant later

const sbHeaders = {
  apikey:        SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type':'application/json',
};

// ── SUPABASE HELPERS ──────────────────────────────────────────────────
const sbGet = async (path) => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbHeaders });
  if (!res.ok) throw new Error(`Supabase GET ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
};

const sbPatch = async (path, body) => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: { ...sbHeaders, Prefer: 'return=representation' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase PATCH ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
};

const sbInsert = async (path, body) => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: { ...sbHeaders, Prefer: 'return=representation' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase POST ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
};

// ── TRANSFORMATIE: Supabase row → Monday-stijl object voor frontend ───
// De frontend (index.html) verwacht exact deze veldnamen — niet aanraken.
const rowToMondayShape = (b, makelaarNaam = '') => {
  // datum_tijd splitsen in 'datum' (YYYY-MM-DD) en 'tijdstip' (HH:MM Europe/Amsterdam)
  let datum = '', tijdstip = null;
  if (b.datum_tijd) {
    try {
      const d = new Date(b.datum_tijd);
      // Datum in lokale (Amsterdam) zone
      const dParts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Amsterdam',
        year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(d);
      datum = `${dParts.find(p=>p.type==='year').value}-${dParts.find(p=>p.type==='month').value}-${dParts.find(p=>p.type==='day').value}`;
      // Tijd HH:MM
      tijdstip = d.toLocaleTimeString('nl-NL', {
        timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit',
      });
    } catch { /* fallback: laat datum/tijdstip leeg */ }
  }

  // feedback_keys is een PG ARRAY → joinen tot CSV voor backwards compat
  const feedbackCsv = Array.isArray(b.feedback_keys) ? b.feedback_keys.join(',') : '';

  // Afleiden van legacy booleans uit actie_status
  const actie  = (b.actie_status || '').toLowerCase();
  const inPool = (actie === 'pool');
  const niet_naar_pool = (actie === 'zelf' || actie === 'afgehandeld');
  const doorgegeven    = (actie === 'pool');

  return {
    id:             String(b.id),
    naam:           b.bezichtiger_naam || '',
    adres:          b.adres || '',
    makelaar:       makelaarNaam,
    datum,
    tijdstip,
    telefoon:       b.bezichtiger_telefoon || '',
    email:          b.bezichtiger_email || '',
    niet_naar_pool,
    doorgegeven,
    in_pool:        inPool,
    gearchiveerd:   !!b.gearchiveerd,
    feedback:       feedbackCsv,
    opmerking:      b.feedback_opmerking || '',
    actie_status:   b.actie_status || '',
  };
};

const isMVAMakelaar = (naam) => {
  const n = (naam || '').toLowerCase();
  if (n.includes('filipe') || n.includes('bataglia')) return false;
  if (n.includes('gert-jan') || n.includes('gertjan') || n.includes('gert jan')) return false;
  return true;
};

// ── ROUND ROBIN: kies de volgende makelaar uit pool ───────────────────
// Strategie:
//   1. Selecteer alle gebruikers die meedoen aan RR + actief zijn + niet de gever
//   2. Sorteer op volgnummer_laatste_toewijzing ASC, dan id ASC (deterministisch)
//   3. Pak nummer 1 → die is langst niet aan de beurt geweest
//   4. Update zijn volgnummer naar (max + 1)
//   5. Schrijf record in toewijzingen tabel als audit trail
const roundRobinPick = async (bezichtigingId, gevendeMakelaarId) => {
  // 1. Pool ophalen — alle gebruikers met doet_mee_round_robin=true en actief=true
  const pool = await sbGet(
    `gebruikers?select=id,naam,email,volgnummer_laatste_toewijzing` +
    `&doet_mee_round_robin=eq.true&actief=eq.true&kantoor_id=eq.${MVA_KANTOOR_ID}` +
    `&order=volgnummer_laatste_toewijzing.asc.nullsfirst,id.asc`
  );

  // Verwijder de gevende makelaar uit de pool — die mag z'n eigen lead niet terugkrijgen
  const candidates = pool.filter(g => g.id !== gevendeMakelaarId);
  if (candidates.length === 0) {
    throw new Error('Geen kandidaten beschikbaar in Round Robin pool');
  }

  // 2. Eerste kandidaat = volgnummer laagst → wint
  const gekozen = candidates[0];

  // 3. Nieuw volgnummer = max + 1 (over hele pool incl. gever, voor mooi oplopend)
  const huidigMax = pool.reduce((m, g) =>
    Math.max(m, g.volgnummer_laatste_toewijzing || 0), 0);
  const nieuwVolgnummer = huidigMax + 1;

  // 4. Update gekozen makelaar
  await sbPatch(`gebruikers?id=eq.${gekozen.id}`, {
    volgnummer_laatste_toewijzing: nieuwVolgnummer,
  });

  // 5. Audit trail in toewijzingen
  await sbInsert('toewijzingen', {
    kantoor_id:       MVA_KANTOOR_ID,
    bezichtiging_id:  bezichtigingId,
    gebruiker_id:     gekozen.id,
    toegewezen_op:    new Date().toISOString(),
    status:           'toegewezen',
  });

  return {
    gekozen_id:       gekozen.id,
    gekozen_naam:     gekozen.naam,
    gekozen_email:    gekozen.email,
    nieuw_volgnummer: nieuwVolgnummer,
    pool_grootte:     candidates.length,
  };
};

// ─────────────────────────────────────────────────────────────────────
// HANDLER
// ─────────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type':                 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const { action, data } = JSON.parse(event.body || '{}');

  try {
    // ═════════════════════════════════════════════════════════════════
    // GROEP 1 — BEZICHTIGINGEN-ACTIES (Supabase)
    // ═════════════════════════════════════════════════════════════════

    // ── BEZICHTIGINGEN OPHALEN (alle open, voor gevende makelaar) ────
    if (action === 'get_bezichtigingen') {
      const { makelaar_naam, makelaar_email } = data;

      // Lookup gebruiker_id via email (voorkeur) of naam
      let makelaarId = null, makelaarNaam = makelaar_naam || '';
      if (makelaar_email) {
        const u = await sbGet(`gebruikers?select=id,naam&email=eq.${encodeURIComponent(makelaar_email.toLowerCase())}`);
        if (u[0]) { makelaarId = u[0].id; makelaarNaam = u[0].naam; }
      }
      if (!makelaarId && makelaar_naam) {
        const u = await sbGet(`gebruikers?select=id,naam&naam=eq.${encodeURIComponent(makelaar_naam)}`);
        if (u[0]) { makelaarId = u[0].id; makelaarNaam = u[0].naam; }
      }
      if (!makelaarId) {
        return { statusCode: 200, headers, body: JSON.stringify({ bezichtigingen: [], info: 'gebruiker niet gevonden' }) };
      }

      // Alle niet-gearchiveerde bezichtigingen voor deze gever
      const rows = await sbGet(
        `bezichtigingen?select=*&gevende_makelaar_id=eq.${makelaarId}` +
        `&gearchiveerd=eq.false&order=datum_tijd.desc&limit=500`
      );

      const bezichtigingen = rows
        .map(r => rowToMondayShape(r, makelaarNaam))
        .filter(b => isMVAMakelaar(b.makelaar));

      return { statusCode: 200, headers, body: JSON.stringify({ bezichtigingen }) };
    }

    // ── GEARCHIVEERDE BEZICHTIGINGEN OPHALEN ─────────────────────────
    if (action === 'get_gearchiveerde_bezichtigingen') {
      const { makelaar_naam, makelaar_email } = data;

      let makelaarId = null, makelaarNaam = makelaar_naam || '';
      if (makelaar_email) {
        const u = await sbGet(`gebruikers?select=id,naam&email=eq.${encodeURIComponent(makelaar_email.toLowerCase())}`);
        if (u[0]) { makelaarId = u[0].id; makelaarNaam = u[0].naam; }
      }
      if (!makelaarId && makelaar_naam) {
        const u = await sbGet(`gebruikers?select=id,naam&naam=eq.${encodeURIComponent(makelaar_naam)}`);
        if (u[0]) { makelaarId = u[0].id; makelaarNaam = u[0].naam; }
      }
      if (!makelaarId) {
        return { statusCode: 200, headers, body: JSON.stringify({ bezichtigingen: [] }) };
      }

      const rows = await sbGet(
        `bezichtigingen?select=*&gevende_makelaar_id=eq.${makelaarId}` +
        `&gearchiveerd=eq.true&order=datum_tijd.desc&limit=500`
      );

      const bezichtigingen = rows.map(r => rowToMondayShape(r, makelaarNaam));
      return { statusCode: 200, headers, body: JSON.stringify({ bezichtigingen }) };
    }

    // ── ARCHIVEREN ───────────────────────────────────────────────────
    if (action === 'archiveer_bezichtiging') {
      const { item_id, archiveer } = data;
      const naarArchief = archiveer !== false;

      const updated = await sbPatch(`bezichtigingen?id=eq.${item_id}`, {
        gearchiveerd:        naarArchief,
        status_gewijzigd_op: new Date().toISOString(),
      });

      return {
        statusCode: 200, headers,
        body: JSON.stringify({ ok: true, gearchiveerd: naarArchief, item_id, updated_count: updated.length }),
      };
    }

    // ── MARKEER AFGEHANDELD ──────────────────────────────────────────
    if (action === 'markeer_afgehandeld') {
      const { item_id } = data;

      const updated = await sbPatch(`bezichtigingen?id=eq.${item_id}`, {
        actie_status:        'afgehandeld',
        status_gewijzigd_op: new Date().toISOString(),
      });

      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, item_id, updated_count: updated.length }) };
    }

    // ── PUSH NAAR POOL (Round Robin) ─────────────────────────────────
    if (action === 'push_naar_pool') {
      const { item_id } = data;

      // Lees bezichtiging om gevende_makelaar_id te kennen
      const bez = await sbGet(`bezichtigingen?select=id,gevende_makelaar_id,actie_status&id=eq.${item_id}`);
      if (!bez[0]) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: `Bezichtiging ${item_id} niet gevonden` }) };
      }

      // Round Robin: kies ontvanger
      let rr;
      try {
        rr = await roundRobinPick(parseInt(item_id), bez[0].gevende_makelaar_id);
      } catch (e) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: `Round Robin faalde: ${e.message}` }) };
      }

      // Markeer bezichtiging als 'pool'
      await sbPatch(`bezichtigingen?id=eq.${item_id}`, {
        actie_status:        'pool',
        status_gewijzigd_op: new Date().toISOString(),
      });

      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          ok: true,
          item_id,
          toegewezen_aan:   rr.gekozen_naam,
          email_toegewezen: rr.gekozen_email,
          gekozen_id:       rr.gekozen_id,
          pool_grootte:     rr.pool_grootte,
        }),
      };
    }

    // ── PUSH NAAR EIGEN BELLIJST (Zelf bellen) ───────────────────────
    // Voor nu: zet alleen de status. De échte kopie naar het bellijst-board
    // (Monday) wordt in een latere fase gemigreerd zodra de bellijst-tabel
    // in Supabase bestaat. De bestaande Make.com / Monday-flow voor de
    // bellijst zelf blijft onveranderd.
    if (action === 'push_naar_eigen_bellijst') {
      const { item_id } = data;

      const updated = await sbPatch(`bezichtigingen?id=eq.${item_id}`, {
        actie_status:        'zelf',
        status_gewijzigd_op: new Date().toISOString(),
      });

      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          ok: true,
          item_id,
          actie_status: 'zelf',
          note: 'Bellijst-board kopie nog niet gemigreerd (Fase 2).',
        }),
      };
    }

    // ── FEEDBACK OPSLAAN ─────────────────────────────────────────────
    if (action === 'sla_feedback_op') {
      const { item_id, feedback, opmerking } = data;

      // feedback komt binnen als CSV-string ('serieus,verkoop') → naar PG ARRAY
      const keys = (feedback || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

      const updated = await sbPatch(`bezichtigingen?id=eq.${item_id}`, {
        feedback_keys:       keys,
        feedback_opmerking:  opmerking || '',
        status_gewijzigd_op: new Date().toISOString(),
      });

      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, item_id, updated_count: updated.length }) };
    }

    // ═════════════════════════════════════════════════════════════════
    // GROEP 2 — BELLIJST-ACTIES (nog Monday — niet aangeraakt)
    // ═════════════════════════════════════════════════════════════════
    // Alle onderstaande acties praten nog naar Monday's GraphQL API. Worden
    // in een latere migratiefase op Supabase gezet zodra er een leads/bellijst
    // tabel is. Code 1-op-1 overgenomen uit de oude monday.js.

    const MONDAY_TOKEN = process.env.MONDAY_TOKEN;
    const token = MONDAY_TOKEN.startsWith('Bearer ') ? MONDAY_TOKEN : `Bearer ${MONDAY_TOKEN}`;
    const mondayFetch = async (query, variables = {}) => {
      const res = await fetch('https://api.monday.com/v2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: token, 'API-Version': '2024-01' },
        body: JSON.stringify({ query, variables }),
      });
      return res.json();
    };

    // ── DEBUG: KOLOMMEN OPHALEN ──────────────────────────────────────
    if (action === 'get_columns') {
      const result = await mondayFetch(`
        query ($boardId: ID!) {
          boards(ids: [$boardId]) { name columns { id title type } }
        }
      `, { boardId: data.board_id });
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    // ── LEADS OPHALEN ────────────────────────────────────────────────
    if (action === 'get_leads') {
      const { board_id, makelaar_naam, makelaar_email, bron } = data;
      const result = await mondayFetch(`
        query ($boardId: ID!) {
          boards(ids: [$boardId]) {
            items_page(limit: 100) {
              items { id name column_values { id text value } }
            }
          }
        }
      `, { boardId: board_id });

      const items = result?.data?.boards?.[0]?.items_page?.items || [];
      const leads = items.map(item => {
        const cols = item.column_values || [];
        const emailMakelaar    = cols.find(c => c.id === 'text_mm1n99ky')?.text || '';
        const boardAfkomstig   = cols.find(c => c.id === 'text_mm1mpcr0')?.text || '';
        const toegewezenAan    = cols.find(c => c.id === 'text_mm2rfv9v')?.text || '';
        const emailToegewezen  = cols.find(c => c.id === 'text_mm2r2f05')?.text || '';
        const toegewezenOp     = cols.find(c => c.id === 'date_mm2rm4mg')?.text || '';
        const leadStatus       = cols.find(c => c.id === 'color_mm2rne17')?.text || '';
        const afspraakOp       = cols.find(c => c.id === 'date_mm2r1yem')?.text || '';
        const dealOp           = cols.find(c => c.id === 'date_mm2r29y4')?.text || '';
        const belpogingen      = cols.find(c => c.id === 'numeric_mm2rxahc')?.text || '0';
        const bronAfgeleid     = toegewezenAan ? 'leadpool' : 'eigen';

        return {
          id: item.id, naam: item.name,
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
          toegewezen_aan:     toegewezenAan,
          email_toegewezen:   emailToegewezen,
          toegewezen_op:      toegewezenOp,
          lead_status:        leadStatus,
          afspraak_op:        afspraakOp,
          deal_op:            dealOp,
          bron:               bronAfgeleid,
          belpogingen:        parseInt(belpogingen) || 0,
        };
      }).filter(lead => {
        if (lead.lead_status === 'Lost' || lead.lead_status === 'Deal') return false;
        if (bron === 'eigen') return true;
        if (!makelaar_naam && !makelaar_email) return true;
        const naam     = (makelaar_naam || '').toLowerCase();
        const voornaam = naam.split(' ')[0];
        const email    = (makelaar_email || '').toLowerCase();
        if (email && lead.email_toegewezen.toLowerCase() === email) return true;
        if (voornaam && lead.toegewezen_aan.toLowerCase().includes(voornaam)) return true;
        const board  = lead.board_afkomstig.toLowerCase();
        const emailM = lead.email_makelaar.toLowerCase();
        if (board && board.includes(voornaam)) return true;
        if (emailM && emailM.includes(voornaam)) return true;
        return false;
      });

      return { statusCode: 200, headers, body: JSON.stringify({ leads }) };
    }

    // ── EIGEN BELLIJST-BOARD OPHALEN ─────────────────────────────────
    if (action === 'get_eigen_bellijst_board') {
      const { makelaar_naam, makelaar_email } = data;
      if (!makelaar_naam && !makelaar_email) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'makelaar_naam of makelaar_email verplicht' }) };
      }
      const meedoenResult = await mondayFetch(`
        query {
          boards(ids: [5093235823]) {
            items_page(limit: 50) { items { name column_values { id text } } }
          }
        }
      `);
      const meedoenItems = meedoenResult?.data?.boards?.[0]?.items_page?.items || [];
      const emailLower = (makelaar_email || '').toLowerCase();
      const naamLower  = (makelaar_naam || '').toLowerCase();
      const voornaam   = naamLower.split(' ')[0];

      let gevonden = null;
      if (emailLower) {
        gevonden = meedoenItems.find(m => {
          const e = m.column_values.find(c => c.id === 'text_mm1nxwsn')?.text || '';
          return e.toLowerCase() === emailLower;
        });
      }
      if (!gevonden && naamLower) gevonden = meedoenItems.find(m => m.name.toLowerCase() === naamLower);
      if (!gevonden && voornaam) {
        const matches = meedoenItems.filter(m => m.name.toLowerCase().split(' ')[0] === voornaam);
        if (matches.length === 1) gevonden = matches[0];
      }
      if (!gevonden) {
        return { statusCode: 200, headers, body: JSON.stringify({ ok: false, reden: 'Makelaar niet gevonden in Meedoen-board' }) };
      }
      const boardLabel = gevonden.column_values.find(c => c.id === 'text_mm1gbj3q')?.text || '';
      const boardId    = BELLIJST_LABELS[boardLabel] || null;
      return {
        statusCode: 200, headers,
        body: JSON.stringify({ ok: !!boardId, board_id: boardId, board_label: boardLabel, makelaar: gevonden.name }),
      };
    }

    // ── LEADPOOL STATUS UPDATE ───────────────────────────────────────
    if (action === 'update_lead_status') {
      const { item_id, lead_status } = data;
      if (!item_id || !lead_status) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'item_id en lead_status verplicht' }) };
      }
      const vandaag = new Date().toISOString().split('T')[0];
      const columnValues = { color_mm2rne17: { label: lead_status } };
      if (lead_status === 'Afspraak') columnValues.date_mm2r1yem = { date: vandaag };
      if (lead_status === 'Deal')     columnValues.date_mm2r29y4 = { date: vandaag };

      if (lead_status === 'NietBereikt') {
        const huidigRes = await mondayFetch(`
          query ($itemId: ID!) {
            items(ids: [$itemId]) { column_values(ids: ["numeric_mm2rxahc"]) { text } }
          }
        `, { itemId: item_id });
        const huidigText = huidigRes?.data?.items?.[0]?.column_values?.[0]?.text || '0';
        const nieuweTeller = (parseInt(huidigText) || 0) + 1;
        await mondayFetch(`
          mutation ($itemId: ID!, $columnValues: JSON!) {
            change_multiple_column_values(item_id: $itemId, board_id: 5093190545, column_values: $columnValues) { id }
          }
        `, { itemId: item_id, columnValues: JSON.stringify({ numeric_mm2rxahc: String(nieuweTeller) }) });
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, belpogingen: nieuweTeller, lead_status: 'Toegewezen' }) };
      }

      await mondayFetch(`
        mutation ($itemId: ID!, $columnValues: JSON!) {
          change_multiple_column_values(item_id: $itemId, board_id: 5093190545, column_values: $columnValues) { id }
        }
      `, { itemId: item_id, columnValues: JSON.stringify(columnValues) });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, lead_status }) };
    }

    // ── UPDATE BELLIJST-STATUS (op een specifiek bellijst-board) ─────
    if (action === 'update_status') {
      const { item_id, board_id, status } = data;
      const statusLabels = {
        bereikt_ja:          'Bereikt',
        bereikt_later:       'Bel terug',
        niet_bereikbaar:     'Niet bereikbaar',
        wellicht_later:      'Wellicht later',
        niet_geinteresseerd: 'Niet geïnteresseerd',
        voicemail:           'Voicemail',
      };
      const result = await mondayFetch(`
        mutation ($itemId: ID!, $boardId: ID!, $value: JSON!) {
          change_column_value(item_id: $itemId, board_id: $boardId, column_id: "color_mm1f9atj", value: $value) { id }
        }
      `, { itemId: item_id, boardId: board_id, value: JSON.stringify({ label: statusLabels[status] || status }) });
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    // ── ALLE MAKELAARS / GET_MAKELAARS ──────────────────────────────
    if (action === 'get_alle_makelaars' || action === 'get_makelaars') {
      const result = await mondayFetch(`{
        boards(ids: [5093235823]) {
          items_page(limit: 50) { items { id name column_values { id text value } } }
        }
      }`);
      const items = result?.data?.boards?.[0]?.items_page?.items || [];
      const makelaars = items.map(item => {
        const cols = item.column_values || [];
        return {
          naam:     item.name,
          email:    cols.find(c => c.id === 'text_mm1nxwsn')?.text || '',
          actief:   cols.find(c => c.id === 'boolean_mm1g4fwm')?.text === 'true',
          meedoen:  cols.find(c => c.id === 'boolean_mm1g4fwm')?.text || '',
          vakantie: cols.find(c => c.id === 'timerange_mm1gj38w')?.text || '',
          board:    cols.find(c => c.id === 'text_mm1gbj3q')?.text || '',
        };
      })
      .filter(m => m.email)
      .filter(m => isMVAMakelaar(m.naam));

      const filtered = (action === 'get_makelaars')
        ? makelaars.filter(m => m.meedoen === 'true' || m.meedoen === 'v')
        : makelaars.sort((a, b) => a.naam.localeCompare(b.naam));

      return { statusCode: 200, headers, body: JSON.stringify({ makelaars: filtered }) };
    }

    // ── ASSIGN MAKELAAR (oude RR, niet meer gebruikt) ────────────────
    // Behouden voor backwards compat — nieuwe flow loopt via push_naar_pool.
    if (action === 'assign_makelaar') {
      return {
        statusCode: 410, headers,
        body: JSON.stringify({ error: 'assign_makelaar is gemigreerd naar push_naar_pool (Round Robin in Supabase)' }),
      };
    }

    return {
      statusCode: 400, headers,
      body: JSON.stringify({ error: `Onbekende actie: ${action}` }),
    };
  } catch (err) {
    return {
      statusCode: 500, headers,
      body: JSON.stringify({ error: err.message, action }),
    };
  }
};
