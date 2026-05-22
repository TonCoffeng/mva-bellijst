// netlify/functions/openhuis-inschrijving.js
// ─────────────────────────────────────────────────────────────────────────────
// PUBLIEKE functie — verwerkt open-huis-inschrijvingen vanaf openhuis.html.
//
// Bezoekers hebben GEEN account en GEEN Supabase-toegang. Deze functie is de
// enige weg waarlangs een inschrijving binnenkomt. Beveiliging:
//   - Bezoeker stuurt alleen de publieke_token (geen id, geen makelaar-info)
//   - Functie zoekt de bezichtiging op via die token; bestaat 'ie niet of is
//     het geen open_huis → 404, niets geschreven
//   - Service-key staat alleen server-side (env var), nooit in de browser
//   - Inschrijving wordt een bellijst_item bij de gevende_makelaar van het
//     open huis (bron='openhuis'), met snapshot van naam/mail/telefoon/adres
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const sbHeaders = {
  apikey:        SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type':'application/json',
};

const sbGet = async (path) => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sbHeaders });
  if (!res.ok) throw new Error(`Supabase GET ${path} → ${res.status}: ${await res.text()}`);
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

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Content-Type':                 'application/json',
};

// UUID-formaat validatie — voorkomt onzin-queries
const isUuid = (s) =>
  typeof s === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  // ── GET: open huis ophalen voor weergave op de inschrijfpagina ────
  // openhuis.html?token=... haalt hiermee adres + datum op om te tonen.
  if (event.httpMethod === 'GET') {
    const token = (event.queryStringParameters || {}).token;
    if (!isUuid(token)) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Ongeldige link' }) };
    }
    try {
      const rows = await sbGet(
        `bezichtigingen?select=adres,datum_tijd,type&publieke_token=eq.${token}&type=eq.open_huis`
      );
      if (!rows[0]) {
        return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Open huis niet gevonden' }) };
      }
      return {
        statusCode: 200, headers: CORS,
        body: JSON.stringify({ ok: true, adres: rows[0].adres, datum_tijd: rows[0].datum_tijd }),
      };
    } catch (e) {
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
    }
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Ongeldige aanvraag' }) };
  }

  const { token, naam, email, telefoon, segment, opmerking } = data;

  // ── Validatie ────────────────────────────────────────────────────
  if (!isUuid(token)) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Ongeldige link' }) };
  }
  if (!naam || !naam.trim()) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Naam is verplicht' }) };
  }
  if ((!email || !email.trim()) && (!telefoon || !telefoon.trim())) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Vul e-mail of telefoon in' }) };
  }

  // ── Open huis opzoeken via token ─────────────────────────────────
  let bez;
  try {
    const rows = await sbGet(
      `bezichtigingen?select=*&publieke_token=eq.${token}&type=eq.open_huis`
    );
    if (!rows[0]) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: 'Open huis niet gevonden' }) };
    }
    bez = rows[0];
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message }) };
  }

  if (!bez.gevende_makelaar_id) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Open huis heeft geen makelaar gekoppeld' }) };
  }

  // ── Inschrijving wegschrijven als bellijst_item ──────────────────
  // Volledige kaart bij de verkopend makelaar, identiek aan een bezichtiging.
  // segment ('Aankoop'/'Verkoop'/'') gaat de opmerking in zodat het zichtbaar
  // is zonder schemawijziging.
  const segmentLabel = segment ? `Interesse: ${segment}` : '';
  const opm = [segmentLabel, (opmerking || '').trim()].filter(Boolean).join(' · ');

  try {
    const created = await sbInsert('bellijst_items', {
      kantoor_id:           bez.kantoor_id,
      bezichtiging_id:      bez.id,
      eigenaar_id:          bez.gevende_makelaar_id,
      bron:                 'openhuis',
      bezichtiger_naam:     naam.trim(),
      bezichtiger_email:    (email || '').trim(),
      bezichtiger_telefoon: (telefoon || '').trim(),
      adres:                bez.adres,
      datum_tijd:           bez.datum_tijd,
      bel_status:           'nieuw',
      belpogingen:          0,
      opmerking:            opm || null,
    });
    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({ ok: true, id: created[0]?.id }),
    };
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: `Inschrijving opslaan faalde: ${e.message}` }) };
  }
};
