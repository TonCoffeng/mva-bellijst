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

// ── BELLIJST: maak een nieuw bellijst-item op basis van een bezichtiging ──
// Snapshot van bezichtiger-info wordt bevroren in het bellijst-item zodat
// het stabiel blijft tegen latere mutaties van de bezichtiging.
const createBellijstItem = async (bezichtiging, eigenaarId, bron) => {
  return await sbInsert('bellijst_items', {
    kantoor_id:           bezichtiging.kantoor_id || MVA_KANTOOR_ID,
    bezichtiging_id:      bezichtiging.id,
    eigenaar_id:          eigenaarId,
    bron:                 bron, // 'zelf' of 'pool'
    bezichtiger_naam:     bezichtiging.bezichtiger_naam,
    bezichtiger_email:    bezichtiging.bezichtiger_email,
    bezichtiger_telefoon: bezichtiging.bezichtiger_telefoon,
    adres:                bezichtiging.adres,
    datum_tijd:           bezichtiging.datum_tijd,
    bel_status:           'nieuw',
    belpogingen:          0,
  });
};

// ── BEZICHTIGING: archiveer + zet actie_status tegelijk in 1 PATCH ────
// Gebruikt voor markeer_afgehandeld, push_naar_pool, push_naar_eigen_bellijst
// zodat een lead na uitgaan uit de gevende lijst altijd terugvindbaar is.
const archiveerBezichtiging = async (id, actieStatus) => {
  return await sbPatch(`bezichtigingen?id=eq.${id}`, {
    actie_status:        actieStatus, // 'pool' | 'zelf' | 'afgehandeld'
    gearchiveerd:        true,
    status_gewijzigd_op: new Date().toISOString(),
  });
};

// ── ROUND ROBIN: kies de volgende makelaar uit pool ───────────────────
// Strategie:
//   1. Selecteer alle gebruikers die meedoen aan RR + actief + niet op vakantie + niet de gever
//   2. Sorteer op volgnummer_laatste_toewijzing ASC, dan id ASC (deterministisch)
//   3. Pak nummer 1 → die is langst niet aan de beurt geweest
//   4. Update zijn volgnummer naar (max + 1)
//   5. Schrijf record in toewijzingen tabel als audit trail (status='open')
const roundRobinPick = async (bezichtigingId, gevendeMakelaarId) => {
  // 1. Pool ophalen — alle gebruikers met doet_mee_round_robin=true en actief=true
  // Vakantie-filter doen we lokaal (datum-vergelijking is leesbaarder dan PostgREST or-clauses)
  const pool = await sbGet(
    `gebruikers?select=id,naam,email,volgnummer_laatste_toewijzing,vakantie_van,vakantie_tot` +
    `&doet_mee_round_robin=eq.true&actief=eq.true&kantoor_id=eq.${MVA_KANTOOR_ID}` +
    `&order=volgnummer_laatste_toewijzing.asc.nullsfirst,id.asc`
  );

  // Filter: niet de gever, en niet op vakantie vandaag
  const vandaag = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const opVakantie = (g) => {
    if (!g.vakantie_van || !g.vakantie_tot) return false;
    return g.vakantie_van <= vandaag && vandaag <= g.vakantie_tot;
  };

  const candidates = pool.filter(g =>
    g.id !== gevendeMakelaarId && !opVakantie(g)
  );

  if (candidates.length === 0) {
    throw new Error(
      `Geen kandidaten beschikbaar in Round Robin pool ` +
      `(pool=${pool.length}, op_vakantie=${pool.filter(opVakantie).length}, gever=${gevendeMakelaarId})`
    );
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

  // 5. Audit trail in toewijzingen (status='open' = wachtend op acceptatie)
  await sbInsert('toewijzingen', {
    kantoor_id:       MVA_KANTOOR_ID,
    bezichtiging_id:  bezichtigingId,
    gebruiker_id:     gekozen.id,
    toegewezen_op:    new Date().toISOString(),
    status:           'open',
  });

  return {
    gekozen_id:       gekozen.id,
    gekozen_naam:     gekozen.naam,
    gekozen_email:    gekozen.email,
    nieuw_volgnummer: nieuwVolgnummer,
    pool_grootte:     candidates.length,
    op_vakantie:      pool.filter(opVakantie).map(g => g.naam),
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
    // Lead is afgehandeld zonder dat hij naar bellijst of pool gaat.
    // (bv. al klant elders, no-show, irrelevant). Gaat direct naar archief.
    if (action === 'markeer_afgehandeld') {
      const { item_id } = data;
      const updated = await archiveerBezichtiging(item_id, 'afgehandeld');
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, item_id, updated_count: updated.length }) };
    }

    // ── PUSH NAAR POOL (Round Robin) ─────────────────────────────────
    // Lead naar de leadpool: Round Robin kiest ontvanger, bezichtiging
    // gaat naar archief, en er wordt een bellijst_item aangemaakt voor
    // de ontvanger met bron='pool'.
    //
    // Optioneel: data.direct_naar_email = '<email>' bypassed Round Robin
    // en wijst de lead direct toe aan die makelaar. Wordt gebruikt door
    // de "slimme routing" flow: als de bezichtiger al in Cloze bekend is
    // bij makelaar X, gaat de lead direct naar X (niet via RR).
    if (action === 'push_naar_pool') {
      const { item_id, direct_naar_email } = data;

      // Lees volledige bezichtiging (nodig voor snapshot in bellijst_item)
      const bezRows = await sbGet(`bezichtigingen?select=*&id=eq.${item_id}`);
      if (!bezRows[0]) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: `Bezichtiging ${item_id} niet gevonden` }) };
      }
      const bez = bezRows[0];

      // Bepaal ontvanger: direct toewijzen of via Round Robin
      let rr;
      const useDirectAssign = !!direct_naar_email;

      if (useDirectAssign) {
        // ── Direct toewijzen aan opgegeven email (bypass RR) ─────────
        const targetEmail = String(direct_naar_email).toLowerCase().trim();
        const userRows = await sbGet(
          `gebruikers?email=eq.${encodeURIComponent(targetEmail)}` +
          `&actief=eq.true&select=id,naam,email,kantoor_id`
        );
        if (!userRows[0]) {
          return {
            statusCode: 400, headers,
            body: JSON.stringify({
              error: `Direct-toewijzing faalde: gebruiker ${targetEmail} niet gevonden of inactief`
            }),
          };
        }
        const target = userRows[0];

        // Audit trail: zelfde structuur als roundRobinPick gebruikt, zodat
        // toewijzingen-tabel consistent blijft. status='open' = wachtend op
        // acceptatie. We loggen geen 'aanleiding' in de DB (kolom bestaat
        // niet) — onderscheid met RR zit in de bron='cloze_direct' op
        // bellijst_items en in via_cloze_routing in de response.
        await sbInsert('toewijzingen', {
          kantoor_id:      MVA_KANTOOR_ID,
          bezichtiging_id: parseInt(item_id),
          gebruiker_id:    target.id,
          toegewezen_op:   new Date().toISOString(),
          status:          'open',
        });

        rr = {
          gekozen_id: target.id,
          gekozen_naam: target.naam,
          gekozen_email: target.email,
          pool_grootte: null,  // n.v.t. — was bypass
        };
      } else {
        // ── Standaard: Round Robin ───────────────────────────────────
        try {
          rr = await roundRobinPick(parseInt(item_id), bez.gevende_makelaar_id);
        } catch (e) {
          return { statusCode: 500, headers, body: JSON.stringify({ error: `Round Robin faalde: ${e.message}` }) };
        }
      }

      // Maak bellijst_item voor de gekozen ontvanger (snapshot van bezichtiger)
      let bellijstItem;
      try {
        const bron = useDirectAssign ? 'cloze_direct' : 'pool';
        const created = await createBellijstItem(bez, rr.gekozen_id, bron);
        bellijstItem = created[0];
      } catch (e) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: `Bellijst-item aanmaken faalde: ${e.message}` }) };
      }

      // Archiveer bezichtiging (uit gevende lijst, in archief vindbaar)
      await archiveerBezichtiging(item_id, 'pool');

      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          ok: true,
          item_id,
          toegewezen_aan:    rr.gekozen_naam,
          email_toegewezen:  rr.gekozen_email,
          gekozen_id:        rr.gekozen_id,
          pool_grootte:      rr.pool_grootte,
          bellijst_item_id:  bellijstItem?.id,
          via_cloze_routing: useDirectAssign,  // true = bypass RR
        }),
      };
    }

    // ── PUSH NAAR EIGEN BELLIJST (Zelf bellen) ───────────────────────
    // Lead naar eigen bellijst: bezichtiging gaat naar archief, bellijst_item
    // wordt aangemaakt voor de gevende makelaar zelf met bron='zelf'.
    if (action === 'push_naar_eigen_bellijst') {
      const { item_id } = data;

      // Lees volledige bezichtiging (nodig voor snapshot + gevende_makelaar_id)
      const bezRows = await sbGet(`bezichtigingen?select=*&id=eq.${item_id}`);
      if (!bezRows[0]) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: `Bezichtiging ${item_id} niet gevonden` }) };
      }
      const bez = bezRows[0];

      if (!bez.gevende_makelaar_id) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: `Bezichtiging ${item_id} heeft geen gevende_makelaar_id` }) };
      }

      // Maak bellijst_item voor de gever zelf
      let bellijstItem;
      try {
        const created = await createBellijstItem(bez, bez.gevende_makelaar_id, 'zelf');
        bellijstItem = created[0];
      } catch (e) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: `Bellijst-item aanmaken faalde: ${e.message}` }) };
      }

      // Archiveer bezichtiging
      await archiveerBezichtiging(item_id, 'zelf');

      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          ok: true,
          item_id,
          actie_status:     'zelf',
          eigenaar_id:      bez.gevende_makelaar_id,
          bellijst_item_id: bellijstItem?.id,
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
    // GROEP 2 — BELLIJST-ACTIES (Supabase)
    // ═════════════════════════════════════════════════════════════════
    // Bellijst-items leven in tabel `bellijst_items`. Per makelaar kunnen er
    // items zijn met bron='zelf' (zelf gepushte lead) of bron='pool' (RR).
    //
    // Backwards compatible: response van get_leads heeft dezelfde shape als
    // de oude Monday-versie (id, naam, telefoon, email, adres, datum, status,
    // belpogingen, etc.) zodat public/index.html ongewijzigd kan blijven.

    // ── BELLIJST OPHALEN (ontvangende lijst voor 1 makelaar) ─────────
    if (action === 'get_leads') {
      const { makelaar_naam, makelaar_email, bron } = data;

      // Lookup eigenaar_id via email (voorkeur) of naam
      let eigenaarId = null;
      if (makelaar_email) {
        const u = await sbGet(`gebruikers?select=id&email=eq.${encodeURIComponent(makelaar_email.toLowerCase())}`);
        if (u[0]) eigenaarId = u[0].id;
      }
      if (!eigenaarId && makelaar_naam) {
        const u = await sbGet(`gebruikers?select=id&naam=eq.${encodeURIComponent(makelaar_naam)}`);
        if (u[0]) eigenaarId = u[0].id;
      }
      if (!eigenaarId) {
        return { statusCode: 200, headers, body: JSON.stringify({ leads: [] }) };
      }

      // Filter: alleen actieve bellijst-items (niet deal/lost — die zijn weg uit werklijst)
      let path = `bellijst_items?select=*&eigenaar_id=eq.${eigenaarId}` +
        `&bel_status=not.in.(deal,lost)&order=toegevoegd_op.desc&limit=500`;
      // Optionele bron-filter (bv. alleen 'pool' tonen)
      if (bron === 'pool' || bron === 'zelf') {
        path += `&bron=eq.${bron}`;
      }
      const items = await sbGet(path);

      // Transformeer naar Monday-stijl shape voor frontend backwards compat
      const leads = items.map(it => ({
        id:                 String(it.id),
        naam:               it.bezichtiger_naam || '',
        telefoon:           it.bezichtiger_telefoon || '',
        email:              it.bezichtiger_email || '',
        adres:              it.adres || '',
        datum_bezichtiging: it.datum_tijd ? it.datum_tijd.split('T')[0] : '',
        datum:              it.toegevoegd_op ? it.toegevoegd_op.split('T')[0] : '',
        status:             it.bel_status || 'nieuw',
        warme_lead:         it.warme_lead ? 'true' : '',
        opmerkingen:        it.opmerking || '',
        bron:               it.bron, // 'zelf' of 'pool'
        belpogingen:        it.belpogingen || 0,
        afspraak_op:        it.afspraak_op || '',
        deal_op:            it.deal_op || '',
        bezichtiging_id:    it.bezichtiging_id, // referentie terug naar origineel
      }));

      return { statusCode: 200, headers, body: JSON.stringify({ leads }) };
    }

    // ── BELLIJST STATUS UPDATEN ──────────────────────────────────────
    // Frontend stuurt: { item_id, status } waarbij status één van de oude
    // Monday-keys is (bereikt_ja, bereikt_later, niet_bereikbaar, ...).
    // Vertaal naar onze interne bel_status enum.
    if (action === 'update_status' || action === 'update_lead_status') {
      const { item_id, status, lead_status } = data;
      const inputStatus = status || lead_status;

      // Mapping van oude Monday-keys naar nieuwe bel_status enum
      const statusMap = {
        bereikt_ja:          'bereikt',
        bereikt_later:       'bel_terug',
        niet_bereikbaar:     'niet_bereikbaar',
        wellicht_later:      'wellicht_later',
        niet_geinteresseerd: 'niet_geinteresseerd',
        voicemail:           'voicemail',
        // Lead-status keys (van leadpool flow)
        Bereikt:             'bereikt',
        BelTerug:            'bel_terug',
        NietBereikt:         'niet_bereikbaar',
        Afspraak:            'afspraak',
        Deal:                'deal',
        Lost:                'lost',
      };
      const belStatus = statusMap[inputStatus] || inputStatus;

      // Bouw update body
      const body = {
        bel_status:          belStatus,
        status_gewijzigd_op: new Date().toISOString(),
      };

      // Status-specifieke bijwerkingen
      const vandaag = new Date().toISOString().split('T')[0];
      if (belStatus === 'afspraak') body.afspraak_op = vandaag;
      if (belStatus === 'deal')     body.deal_op = vandaag;

      // Bij niet_bereikbaar / voicemail: belpogingen ophogen
      if (belStatus === 'niet_bereikbaar' || belStatus === 'voicemail') {
        // Lees huidige teller eerst
        const cur = await sbGet(`bellijst_items?select=belpogingen&id=eq.${item_id}`);
        const huidig = cur[0]?.belpogingen || 0;
        body.belpogingen = huidig + 1;
        body.laatst_gebeld_op = new Date().toISOString();
      } else if (belStatus === 'bereikt') {
        body.laatst_gebeld_op = new Date().toISOString();
      }

      const updated = await sbPatch(`bellijst_items?id=eq.${item_id}`, body);
      return {
        statusCode: 200, headers,
        body: JSON.stringify({ ok: true, item_id, bel_status: belStatus, updated_count: updated.length }),
      };
    }

    // ── EIGEN BELLIJST-BOARD (legacy: gaf Monday board ID terug) ─────
    // Niet meer relevant — bellijst is nu in Supabase en query is via
    // eigenaar_id, niet via een board_id. Frontend zou dit niet meer
    // hoeven aan te roepen, maar voor backwards compat geven we 'ok=true'.
    if (action === 'get_eigen_bellijst_board') {
      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          ok: true,
          board_id: 'supabase',
          board_label: 'Bellijst (Supabase)',
          info: 'Bellijst leeft nu in Supabase tabel bellijst_items. Gebruik get_leads met makelaar_email.',
        }),
      };
    }

    // ═════════════════════════════════════════════════════════════════
    // GROEP 3 — LEGACY MONDAY ACTIES (debug + meedoen-board)
    // ═════════════════════════════════════════════════════════════════
    // Het Meedoen Leadpool board op Monday is nog wel de bron-of-truth
    // voor wie er meedoet aan RR. Op termijn: gebruikers.doet_mee_round_robin
    // wordt al gebruikt door RR, maar get_makelaars/get_alle_makelaars
    // queryen nog Monday omdat de frontend dropdowns daarop bouwen.

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

    // ── OUDE MONDAY HANDLERS VERWIJDERD ──────────────────────────────
    // De volgende acties zijn gemigreerd naar Supabase (zie boven):
    //   - get_leads → leest nu uit bellijst_items
    //   - get_eigen_bellijst_board → niet meer nodig (geen board_id)
    //   - update_lead_status → samengevoegd met update_status
    //   - update_status → werkt nu op bellijst_items.bel_status
    // Code rondom Monday's bellijst-boards (5093190545 + 9x bellijst-board)
    // is opgeruimd. BELLIJST_LABELS bovenaan blijft nog wel staan voor het
    // geval er ergens nog een legacy referentie is.

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
