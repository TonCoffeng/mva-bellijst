// netlify/functions/dashboard.js
//
// MVA Leadpool — Dashboard Backend
//
// Levert geaggregeerde statistieken voor het Manager Dashboard.
// Eén endpoint dat alle dashboard-data in een keer teruggeeft als JSON.
//
// Filters via query string of body:
//   - periode: 'vandaag' | 'week' | 'maand' | 'alles'   (default: 'week')
//   - kantoor_id: bigint (optioneel — multi-tenancy voorbereiding)
//
// Multi-tenancy: alle queries filteren op kantoor_id als die is meegegeven.
// Zonder kantoor_id parameter wordt alle data getoond (huidige situatie: alleen MVA).
//
// Authenticatie: deze function controleert NIET op rol/wachtwoord.
// Toegangscontrole gebeurt aan frontend-zijde (link alleen zichtbaar voor rol='admin').
// Bij productie-rollout naar externe tenants: hier server-side auth toevoegen.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false }
});

// ── Periode-berekening ──────────────────────────────────────────────
function periodeStart(periode) {
  const nu = new Date();
  const start = new Date(nu);
  start.setHours(0, 0, 0, 0);

  switch (periode) {
    case 'vandaag':
      return start.toISOString();
    case 'week': {
      // Maandag als weekstart (NL-conventie)
      const dag = start.getDay(); // 0=zo, 1=ma, ...
      const diff = dag === 0 ? 6 : dag - 1;
      start.setDate(start.getDate() - diff);
      return start.toISOString();
    }
    case 'maand':
      start.setDate(1);
      return start.toISOString();
    case 'alles':
    default:
      return null; // geen filter
  }
}

// ── Hoofdhandler ────────────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    // Parameters uitlezen (zowel GET query als POST body)
    let params = {};
    if (event.httpMethod === 'POST' && event.body) {
      try { params = JSON.parse(event.body); } catch (e) { params = {}; }
    } else if (event.queryStringParameters) {
      params = event.queryStringParameters;
    }

    const periode = params.periode || 'week';
    const kantoorId = params.kantoor_id ? parseInt(params.kantoor_id, 10) : null;
    const sinds = periodeStart(periode);

    // ── 1. Gebruikers ophalen (alleen actief, voor display) ───────
    let gebruikersQuery = supabase
      .from('gebruikers')
      .select('id, naam, email, rol, actief, doet_mee_round_robin, volgnummer_laatste_toewijzing, vakantie_van, vakantie_tot, kantoor_id')
      .eq('actief', true);

    if (kantoorId !== null) {
      gebruikersQuery = gebruikersQuery.eq('kantoor_id', kantoorId);
    }

    const { data: gebruikers, error: gErr } = await gebruikersQuery;
    if (gErr) throw new Error('Gebruikers ophalen: ' + gErr.message);

    // ── 2. Bellijst items ophalen voor periode ────────────────────
    let itemsQuery = supabase
      .from('bellijst_items')
      .select('id, kantoor_id, eigenaar_id, bron, bel_status, belpogingen, warme_lead, toegevoegd_op, laatst_gebeld_op, afspraak_op, deal_op, status_gewijzigd_op, lead_status');

    if (kantoorId !== null) {
      itemsQuery = itemsQuery.eq('kantoor_id', kantoorId);
    }
    if (sinds) {
      itemsQuery = itemsQuery.gte('toegevoegd_op', sinds);
    }

    const { data: items, error: iErr } = await itemsQuery;
    if (iErr) throw new Error('Items ophalen: ' + iErr.message);

    // ── 3. KPI-cards: globale aggregaties ─────────────────────────
    const totaal = items.length;
    const deals = items.filter(i => i.deal_op !== null).length;
    const afspraken = items.filter(i => i.afspraak_op !== null).length;
    const conversie = totaal > 0 ? (deals / totaal) * 100 : 0;

    // Bel-snelheid: gemiddelde uren tussen toegevoegd_op en laatst_gebeld_op
    // Alleen items waar daadwerkelijk gebeld is
    const gebeldeItems = items.filter(i => i.laatst_gebeld_op && i.toegevoegd_op);
    let gemBelSnelheid = null;
    if (gebeldeItems.length > 0) {
      const totaalMs = gebeldeItems.reduce((sum, i) => {
        const start = new Date(i.toegevoegd_op).getTime();
        const eerst = new Date(i.laatst_gebeld_op).getTime();
        return sum + (eerst - start);
      }, 0);
      gemBelSnelheid = (totaalMs / gebeldeItems.length) / (1000 * 60 * 60); // uren
    }

    // Openstaand: alles behalve niet_geinteresseerd / lost / (deal is afgerond)
    const eindStatussen = ['niet_geinteresseerd', 'lost'];
    const openstaand = items.filter(i =>
      !eindStatussen.includes(i.bel_status) && !i.deal_op
    ).length;

    const warmeLeads = items.filter(i => i.warme_lead === true).length;

    // ── 4. Status-funnel ──────────────────────────────────────────
    // Definitie: een lead doorloopt nieuw → bereikt → afspraak → deal
    // 'lost' en 'niet_geinteresseerd' zijn zijwaartse exit-paden
    const funnel = {
      nieuw: 0,
      bereikt: 0,
      afspraak: 0,
      deal: 0,
      lost: 0,
      niet_geinteresseerd: 0
    };

    items.forEach(i => {
      if (i.deal_op) {
        funnel.deal++;
      } else if (i.bel_status === 'lost') {
        funnel.lost++;
      } else if (i.bel_status === 'niet_geinteresseerd') {
        funnel.niet_geinteresseerd++;
      } else if (i.bel_status === 'afspraak' || i.afspraak_op) {
        funnel.afspraak++;
      } else if (['bereikt', 'bel_terug', 'wellicht_later'].includes(i.bel_status)) {
        funnel.bereikt++;
      } else {
        // nieuw / niet_bereikbaar / voicemail / null → 'nieuw'
        funnel.nieuw++;
      }
    });

    // ── 5. Per-makelaar tabel ────────────────────────────────────
    const makelaars = gebruikers
      .filter(g => g.rol === 'bellen' || g.rol === 'admin' || !g.rol)
      .map(g => {
        const ownItems = items.filter(i => i.eigenaar_id === g.id);
        const ownGebeld = ownItems.filter(i => i.laatst_gebeld_op).length;
        const ownAfspraken = ownItems.filter(i => i.afspraak_op).length;
        const ownDeals = ownItems.filter(i => i.deal_op).length;
        const ownConversie = ownItems.length > 0
          ? (ownDeals / ownItems.length) * 100
          : 0;

        // Bel-snelheid per makelaar
        const ownGebeldItems = ownItems.filter(i => i.laatst_gebeld_op && i.toegevoegd_op);
        let ownBelSnelheid = null;
        if (ownGebeldItems.length > 0) {
          const totaalMs = ownGebeldItems.reduce((sum, i) => {
            const start = new Date(i.toegevoegd_op).getTime();
            const eerst = new Date(i.laatst_gebeld_op).getTime();
            return sum + (eerst - start);
          }, 0);
          ownBelSnelheid = (totaalMs / ownGebeldItems.length) / (1000 * 60 * 60);
        }

        const openItems = ownItems.filter(i =>
          !eindStatussen.includes(i.bel_status) && !i.deal_op
        ).length;

        // Op vakantie?
        const vandaag = new Date().toISOString().slice(0, 10);
        const opVakantie = g.vakantie_van && g.vakantie_tot &&
          g.vakantie_van <= vandaag && g.vakantie_tot >= vandaag;

        return {
          id: g.id,
          naam: g.naam,
          email: g.email,
          rol: g.rol,
          doet_mee_round_robin: g.doet_mee_round_robin,
          op_vakantie: opVakantie,
          volgnummer: g.volgnummer_laatste_toewijzing,
          ontvangen: ownItems.length,
          gebeld: ownGebeld,
          gebeld_pct: ownItems.length > 0 ? (ownGebeld / ownItems.length) * 100 : 0,
          afspraken: ownAfspraken,
          deals: ownDeals,
          conversie: ownConversie,
          openstaand: openItems,
          bel_snelheid_uur: ownBelSnelheid
        };
      })
      .sort((a, b) => b.ontvangen - a.ontvangen);

    // ── 6. Round Robin balans-check ────────────────────────────────
    // Eerlijkheidsmetriek: spreiding van toewijzingen per RR-deelnemer
    const rrDeelnemers = makelaars.filter(m => m.doet_mee_round_robin);
    const rrAantal = rrDeelnemers.map(m => m.ontvangen);
    const rrGemiddeld = rrAantal.length > 0
      ? rrAantal.reduce((a, b) => a + b, 0) / rrAantal.length
      : 0;
    const rrMax = rrAantal.length > 0 ? Math.max(...rrAantal) : 0;
    const rrMin = rrAantal.length > 0 ? Math.min(...rrAantal) : 0;

    // ── 7. Respons samenstellen ───────────────────────────────────
    const response = {
      meta: {
        periode,
        sinds,
        kantoor_id: kantoorId,
        gegenereerd_op: new Date().toISOString()
      },
      kpi: {
        totaal_leads: totaal,
        deals: deals,
        afspraken: afspraken,
        conversie_pct: conversie,
        gem_bel_snelheid_uur: gemBelSnelheid,
        openstaand: openstaand,
        warme_leads: warmeLeads,
        warme_leads_pct: totaal > 0 ? (warmeLeads / totaal) * 100 : 0
      },
      funnel,
      makelaars,
      round_robin: {
        deelnemers: rrDeelnemers.length,
        gemiddeld: rrGemiddeld,
        max: rrMax,
        min: rrMin,
        spreiding: rrMax - rrMin
      }
    };

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(response)
    };
  } catch (err) {
    console.error('Dashboard error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: err.message,
        stack: err.stack
      })
    };
  }
};
