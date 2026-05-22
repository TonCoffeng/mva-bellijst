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
const RESEND_API_KEY       = process.env.RESEND_API_KEY;
const MAIL_FROM            = 'MVA Leadpool <contact@makelaarsvan.nl>';
const LEADPOOL_URL         = 'https://mvaleadpool.netlify.app/';

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

// ── MAIL HELPER (kopie van monday.js, bewust zelfstandig) ─────────────
const stuurMail = async ({ to, subject, html }) => {
  if (!RESEND_API_KEY) {
    console.warn('[openhuis-mail] RESEND_API_KEY ontbreekt — mail niet verstuurd');
    return { ok: false, reason: 'no_api_key' };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: MAIL_FROM, to, subject, html }),
    });
    if (!res.ok) {
      const txt = await res.text();
      console.error(`[openhuis-mail] Resend ${res.status}: ${txt}`);
      return { ok: false, reason: `http_${res.status}` };
    }
    const json = await res.json();
    console.log(`[openhuis-mail] verstuurd naar ${to} (id=${json.id})`);
    return { ok: true, id: json.id };
  } catch (err) {
    console.error('[openhuis-mail] uitzondering:', err.message);
    return { ok: false, reason: 'exception' };
  }
};

// Notificatie-mail voor een open-huis-inschrijving (zelfde stijl als pool-lead).
// rol bepaalt de toon: 'opvolger' = jij volgt deze lead op,
//                      'info'     = ter info, dit kwam op jouw woning.
const renderOpenHuisMail = ({ ontvangerNaam, klantNaam, adres, telefoon, email, opmerking, leadpoolUrl, rol, draaierNaam }) => {
  const esc = s => String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
  const veiligeTel = esc(telefoon || '—');
  const veiligEmail = esc(email || '—');
  const opmerkingBlok = opmerking
    ? `<tr><td style="padding:8px 0;color:#64748b;font-size:13px;width:140px">Opmerking</td>
         <td style="padding:8px 0;color:#1A2B5F;font-size:14px;font-style:italic">${esc(opmerking)}</td></tr>`
    : '';

  const isInfo = rol === 'info';
  const kop = isInfo ? 'Inschrijving op jouw woning' : 'Nieuwe lead van een open huis';
  const intro = isInfo
    ? `Hoi ${esc(ontvangerNaam)}, er heeft zich iemand ingeschreven tijdens een open huis van jouw woning${draaierNaam ? ` (gedraaid door ${esc(draaierNaam)})` : ''}. Deze lead wordt opgevolgd door de makelaar die het open huis deed — dit bericht is ter info.`
    : `Hoi ${esc(ontvangerNaam)}, je hebt een nieuwe lead binnengehaald op het open huis. Deze lead is voor jou om op te volgen.`;
  const voetnoot = isInfo
    ? 'Ter info — de opvolging ligt bij de makelaar die het open huis deed.'
    : 'Deze inschrijving kwam binnen via de open-huis QR-code. Jij volgt deze op.';

  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f4f6fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f4f6fa;padding:24px 0">
    <tr><td align="center">
      <table cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden">
        <tr><td style="background:#1A2B5F;padding:20px 24px;color:white">
          <div style="font-size:12px;letter-spacing:0.05em;opacity:0.8;text-transform:uppercase">MVA Leadpool · Open huis</div>
          <div style="font-size:20px;font-weight:700;margin-top:4px">${kop}</div>
        </td></tr>
        <tr><td style="padding:24px">
          <div style="font-size:15px;color:#1A2B5F;margin-bottom:18px">
            ${intro}
          </div>
          <table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse">
            <tr><td style="padding:8px 0;color:#64748b;font-size:13px;width:140px">Bezoeker</td>
                <td style="padding:8px 0;color:#1A2B5F;font-size:15px;font-weight:600">${esc(klantNaam)}</td></tr>
            <tr><td style="padding:8px 0;color:#64748b;font-size:13px">Woning</td>
                <td style="padding:8px 0;color:#1A2B5F;font-size:14px">${esc(adres)}</td></tr>
            <tr><td style="padding:8px 0;color:#64748b;font-size:13px">Telefoon</td>
                <td style="padding:8px 0;color:#1A2B5F;font-size:14px"><a href="tel:${veiligeTel}" style="color:#E8500A;text-decoration:none">${veiligeTel}</a></td></tr>
            <tr><td style="padding:8px 0;color:#64748b;font-size:13px">Email</td>
                <td style="padding:8px 0;color:#1A2B5F;font-size:14px"><a href="mailto:${veiligEmail}" style="color:#E8500A;text-decoration:none">${veiligEmail}</a></td></tr>
            ${opmerkingBlok}
          </table>
          <div style="margin-top:24px;text-align:center">
            <a href="${leadpoolUrl}" style="display:inline-block;background:#E8500A;color:white;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;font-size:14px">
              Open in Leadpool →
            </a>
          </div>
          <div style="margin-top:24px;padding-top:16px;border-top:1px solid #e2e8f0;font-size:12px;color:#94a3b8;text-align:center">
            ${voetnoot}
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
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

  // ── Bepaal opvolger en verkopend makelaar ────────────────────────
  // Afspraak: de lead is voor wie het open huis DRAAIT (open_huis_door_id).
  // De verkopend makelaar (gevende_makelaar_id) krijgt alleen een info-mail.
  // Fallback: oudere open huizen zonder open_huis_door_id → draaier = verkopend.
  const opvolgerId  = bez.open_huis_door_id || bez.gevende_makelaar_id;
  const verkopendId = bez.gevende_makelaar_id;

  // ── Inschrijving wegschrijven als bellijst_item ──────────────────
  // Volledige kaart bij de OPVOLGER (de open-huis-draaier).
  const segmentLabel = segment ? `Interesse: ${segment}` : '';
  const opm = [segmentLabel, (opmerking || '').trim()].filter(Boolean).join(' · ');

  try {
    const created = await sbInsert('bellijst_items', {
      kantoor_id:           bez.kantoor_id,
      bezichtiging_id:      bez.id,
      eigenaar_id:          opvolgerId,
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

    // ── Notificatiemails (fire-and-forget) ────────────────────────
    // 1. Opvolger (draaier): "jij volgt deze lead op"
    // 2. Verkopend makelaar: "ter info" — alleen als dat een ándere persoon is.
    try {
      // Haal beide makelaars in één query
      const ids = [...new Set([opvolgerId, verkopendId])];
      const makelaars = await sbGet(`gebruikers?select=id,naam,email&id=in.(${ids.join(',')})`);
      const byId = {};
      makelaars.forEach(m => { byId[m.id] = m; });

      const opvolger  = byId[opvolgerId];
      const verkopend = byId[verkopendId];

      // Mail naar opvolger
      if (opvolger?.email) {
        const html = renderOpenHuisMail({
          rol:           'opvolger',
          ontvangerNaam: opvolger.naam || '',
          klantNaam:     naam.trim(),
          adres:         bez.adres || '—',
          telefoon:      (telefoon || '').trim(),
          email:         (email || '').trim(),
          opmerking:     opm || '',
          leadpoolUrl:   LEADPOOL_URL,
        });
        await stuurMail({
          to:      opvolger.email,
          subject: `Open huis: nieuwe lead van ${naam.trim()}`,
          html,
        });
      }

      // Info-mail naar verkopend makelaar — alleen als het een andere persoon is
      if (verkopendId !== opvolgerId && verkopend?.email) {
        const html = renderOpenHuisMail({
          rol:           'info',
          ontvangerNaam: verkopend.naam || '',
          draaierNaam:   opvolger?.naam || '',
          klantNaam:     naam.trim(),
          adres:         bez.adres || '—',
          telefoon:      (telefoon || '').trim(),
          email:         (email || '').trim(),
          opmerking:     opm || '',
          leadpoolUrl:   LEADPOOL_URL,
        });
        await stuurMail({
          to:      verkopend.email,
          subject: `Inschrijving op jouw woning (open huis)`,
          html,
        });
      }
    } catch (mailErr) {
      console.error('[openhuis-inschrijving] mail faalde (inschrijving wel opgeslagen):', mailErr.message);
    }

    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({ ok: true, id: created[0]?.id }),
    };
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: `Inschrijving opslaan faalde: ${e.message}` }) };
  }
};
