// netlify/functions/dagoverzicht-check.js
//
// SCHEDULED FUNCTION — draait elke ochtend rond 09:00 (NL).
//
// Doel: vervang de losse per-lead "vergeten te bellen"-mails door ÉÉN
// rustig dagoverzicht per makelaar. Elke makelaar krijgt 's ochtends een
// mail met zijn eigen openstaande leads, gegroepeerd in drie blokken,
// met een knop om direct de Leadpool-app te openen.
//
// Groepen (per makelaar, alleen zijn eigen leads via eigenaar_id):
//   1. Nog niet gebeld   — bel_status = 'nieuw' EN belpogingen = 0
//   2. Opvolgen          — bel_status IN (niet_bereikbaar, voicemail,
//                          bel_terug, wellicht_later)
//   3. Afspraak staat    — lead_status = 'Afspraak'
//
// Uitgesloten: lead_status = Deal / Lost / Gearchiveerd, en
//              bel_status = bereikt / niet_geinteresseerd.
//
// Belangrijk: een makelaar ZONDER openstaande leads krijgt GEEN mail.
//   Een leeg "niets te doen"-mailtje zou zelf weer irritatie worden.
//
// Vervangt: herinnering-check.js (per-lead herinneringsmails). De push bij
//   een NIEUWE lead blijft bestaan — die zit in monday.js (push_naar_pool)
//   en wordt door deze functie niet geraakt.
//
// Cron-schedule staat in netlify.toml. Netlify cron draait in UTC;
//   '0 7 * * *' ≈ 09:00 NL in zomertijd (08:00 NL in wintertijd).

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

// ── MAIL HELPER ─────────────────────────────────────────────────────
async function stuurMail({ to, subject, html }) {
  if (!RESEND_API_KEY) {
    console.warn('[dagoverzicht] RESEND_API_KEY ontbreekt — mail niet verstuurd');
    return { ok: false, reason: 'no_api_key' };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: MAIL_FROM, to, subject, html }),
    });
    if (!res.ok) {
      const txt = await res.text();
      console.error(`[dagoverzicht] Resend ${res.status}: ${txt}`);
      return { ok: false, reason: `http_${res.status}` };
    }
    const json = await res.json();
    console.log(`[dagoverzicht] verstuurd naar ${to} (id=${json.id})`);
    return { ok: true, id: json.id };
  } catch (err) {
    console.error('[dagoverzicht] uitzondering:', err.message);
    return { ok: false, reason: 'exception' };
  }
}

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

// ── EÉN LEAD-RIJ IN DE MAIL ─────────────────────────────────────────
function leadRij(lead) {
  const naam  = esc(lead.bezichtiger_naam || 'Onbekend');
  const adres = esc(lead.adres || '—');
  const tel   = esc(lead.bezichtiger_telefoon || '');
  const telCel = tel
    ? `<a href="tel:${tel}" style="color:#E8500A;text-decoration:none;white-space:nowrap">${tel}</a>`
    : '<span style="color:#94a3b8">—</span>';
  return `
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid #eef1f6;vertical-align:top">
        <div style="font-size:15px;font-weight:600;color:#1A2B5F">${naam}</div>
        <div style="font-size:13px;color:#64748b;margin-top:2px">${adres}</div>
      </td>
      <td style="padding:10px 0;border-bottom:1px solid #eef1f6;text-align:right;vertical-align:top;font-size:14px">${telCel}</td>
    </tr>`;
}

// ── EÉN GROEP-BLOK ──────────────────────────────────────────────────
function groepBlok({ titel, kleur, leads }) {
  if (!leads.length) return '';
  const rijen = leads.map(leadRij).join('');
  return `
    <div style="margin-top:22px">
      <div style="display:inline-block;background:${kleur};color:#ffffff;font-size:12px;font-weight:700;
                  letter-spacing:0.03em;text-transform:uppercase;padding:4px 10px;border-radius:6px">
        ${esc(titel)} · ${leads.length}
      </div>
      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin-top:8px">
        ${rijen}
      </table>
    </div>`;
}

// ── HELE MAIL ───────────────────────────────────────────────────────
function renderDagoverzicht({ ontvangerNaam, nogNietGebeld, opvolgen, afspraken }) {
  const totaal = nogNietGebeld.length + opvolgen.length + afspraken.length;
  const datum = new Date().toLocaleDateString('nl-NL', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/Amsterdam',
  });

  const intro = nogNietGebeld.length
    ? `Goedemorgen ${esc(ontvangerNaam)}, je hebt vandaag ${totaal} open ${totaal === 1 ? 'lead' : 'leads'} staan — waarvan ${nogNietGebeld.length} nog niet gebeld. Een goed moment om mee te starten.`
    : `Goedemorgen ${esc(ontvangerNaam)}, je hebt ${totaal} open ${totaal === 1 ? 'lead' : 'leads'} om op te volgen. Niks nieuws dat nog gebeld moet worden — netjes bijgehouden.`;

  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f4f6fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f4f6fa;padding:24px 0">
    <tr><td align="center">
      <table cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden">
        <tr><td style="background:#1A2B5F;padding:20px 24px;color:white">
          <div style="font-size:12px;letter-spacing:0.05em;opacity:0.8;text-transform:uppercase">MVA Leadpool · Dagoverzicht</div>
          <div style="font-size:20px;font-weight:700;margin-top:4px;text-transform:capitalize">${esc(datum)}</div>
        </td></tr>
        <tr><td style="padding:24px">
          <div style="font-size:15px;color:#1A2B5F;margin-bottom:4px">${intro}</div>

          ${groepBlok({ titel: 'Nog niet gebeld', kleur: '#991b1b', leads: nogNietGebeld })}
          ${groepBlok({ titel: 'Opvolgen',        kleur: '#b45309', leads: opvolgen })}
          ${groepBlok({ titel: 'Afspraak staat',  kleur: '#15803d', leads: afspraken })}

          <div style="margin-top:28px;text-align:center">
            <a href="${LEADPOOL_URL}" style="display:inline-block;background:#E8500A;color:white;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:14px">
              Open de Leadpool →
            </a>
          </div>
          <div style="margin-top:24px;padding-top:16px;border-top:1px solid #e2e8f0;font-size:12px;color:#94a3b8;text-align:center">
            Dit overzicht krijg je één keer per dag. Heb je een lead al afgehandeld? Dan staat hij er morgen niet meer bij.
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

// ── MAIN HANDLER ────────────────────────────────────────────────────
exports.handler = async () => {
  const start = Date.now();
  console.log(`[dagoverzicht] gestart op ${new Date().toISOString()}`);

  const OPVOLG_STATUSSEN = ['niet_bereikbaar', 'voicemail', 'bel_terug', 'wellicht_later'];

  let verstuurd = 0, overgeslagen = 0, fouten = 0;

  try {
    // 1. Alle relevante openstaande leads in één keer ophalen.
    //    We halen alles met een eigenaar dat NIET afgerond is, en groeperen
    //    daarna in code per makelaar (scheelt N queries).
    const items = await sbGet(
      `bellijst_items?` +
      `select=id,eigenaar_id,bel_status,lead_status,belpogingen,bezichtiger_naam,adres,bezichtiger_telefoon,afspraak_op,toegevoegd_op&` +
      `eigenaar_id=not.is.null&` +
      `order=toegevoegd_op.asc&limit=2000`
    );
    console.log(`[dagoverzicht] ${items.length} leads met eigenaar opgehaald`);

    // 2. Per makelaar groeperen in de drie buckets.
    const perMakelaar = new Map(); // eigenaar_id -> { nogNietGebeld, opvolgen, afspraken }
    const bucketVoor = (id) => {
      if (!perMakelaar.has(id)) perMakelaar.set(id, { nogNietGebeld: [], opvolgen: [], afspraken: [] });
      return perMakelaar.get(id);
    };

    for (const it of items) {
      const lead = it.lead_status;       // Hot/Warm/Afspraak/Deal/Lost/Gearchiveerd of null
      const bel  = it.bel_status;        // nieuw/bereikt/niet_bereikbaar/...

      // Afgeronde leads volledig uitsluiten.
      if (lead === 'Deal' || lead === 'Lost' || lead === 'Gearchiveerd') continue;
      if (bel === 'niet_geinteresseerd') continue;

      const b = bucketVoor(it.eigenaar_id);

      if (lead === 'Afspraak') {
        b.afspraken.push(it);
      } else if (bel === 'nieuw' && (it.belpogingen || 0) === 0) {
        b.nogNietGebeld.push(it);
      } else if (OPVOLG_STATUSSEN.includes(bel)) {
        b.opvolgen.push(it);
      }
      // 'bereikt' zonder afspraak/deal: geen actie meer nodig → niet tonen.
    }

    // 3. Makelaar-gegevens ophalen voor wie iets openstaan heeft.
    const makelaarIds = [...perMakelaar.keys()].filter(id =>
      perMakelaar.get(id).nogNietGebeld.length +
      perMakelaar.get(id).opvolgen.length +
      perMakelaar.get(id).afspraken.length > 0
    );

    if (!makelaarIds.length) {
      console.log('[dagoverzicht] geen makelaars met openstaande leads — niets verstuurd');
      return { statusCode: 200, body: JSON.stringify({ ok: true, verstuurd: 0, reden: 'geen openstaande leads' }) };
    }

    const gebruikers = await sbGet(
      `gebruikers?select=id,naam,email,actief&id=in.(${makelaarIds.join(',')})`
    );
    const userById = new Map(gebruikers.map(u => [String(u.id), u]));

    // 4. Per makelaar één mail (alleen als er echt iets openstaat én actief).
    for (const id of makelaarIds) {
      try {
        const u = userById.get(String(id));
        if (!u || u.actief === false || !u.email) { overgeslagen++; continue; }

        const { nogNietGebeld, opvolgen, afspraken } = perMakelaar.get(id);

        const html = renderDagoverzicht({
          ontvangerNaam: u.naam || 'collega',
          nogNietGebeld, opvolgen, afspraken,
        });

        const totaal = nogNietGebeld.length + opvolgen.length + afspraken.length;
        const subject = nogNietGebeld.length
          ? `Je dagoverzicht — ${nogNietGebeld.length} nog te bellen`
          : `Je dagoverzicht — ${totaal} ${totaal === 1 ? 'lead' : 'leads'} open`;

        const r = await stuurMail({ to: u.email, subject, html });
        if (r.ok) verstuurd++; else fouten++;
      } catch (e) {
        console.error(`[dagoverzicht] makelaar ${id} faalde:`, e.message);
        fouten++;
      }
    }

    const duurMs = Date.now() - start;
    console.log(`[dagoverzicht] klaar in ${duurMs}ms — verstuurd: ${verstuurd}, overgeslagen: ${overgeslagen}, fouten: ${fouten}`);

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, verstuurd, overgeslagen, fouten, duur_ms: duurMs }),
    };
  } catch (err) {
    console.error('[dagoverzicht] FATAL:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

// Schedule wordt geregistreerd in netlify.toml ('0 7 * * *' ≈ 09:00 NL zomertijd).
