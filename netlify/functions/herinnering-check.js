// netlify/functions/herinnering-check.js
//
// SCHEDULED FUNCTION — draait elke 15 minuten.
//
// Doel: stuur een vriendelijke herinneringsmail naar makelaars die een lead
// uit de pool hebben gekregen maar er nog niet mee aan de slag zijn gegaan.
//
// Twee niveaus van herinneringen:
//   - Niveau 1: na 1 werkdag (24 werkuren) geen belpoging gedaan
//   - Niveau 2: na 2 werkdagen (48 werkuren) geen belpoging gedaan
//
// Werkdag-definitie: ma-vr, weekend telt niet mee. Concreet:
//   - Vrijdag 14:00 toegewezen → maandag 14:00 herinnering 1
//   - Zaterdag 10:00 toegewezen → dinsdag 09:00 herinnering 1
//     (zaterdag/zondag "toewijzing" gebeurt zelden, maar voor de zekerheid)
//
// "Geen belpoging" = belpogingen = 0 EN bel_status = 'nieuw'
//
// Mail blijft hangen via twee timestamp-velden:
//   - herinnering_1_verzonden_op
//   - herinnering_2_verzonden_op
// Zodat we nooit dubbele mails sturen.
//
// Cron-schedule: elke 15 minuten via netlify.toml (zie deploy-notitie onderaan).

// Schedule wordt geregistreerd in netlify.toml (elke 15 minuten).
// Node 18+ heeft global fetch ingebouwd, geen node-fetch nodig.

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_API_KEY       = process.env.RESEND_API_KEY;
const MAIL_FROM            = 'MVA Leadpool <contact@makelaarsvan.nl>';

// Push naast de herinneringsmail (zelfde moment). Faalt stilletjes.
const { pushNaarMakelaar } = require('./push-send');

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

const sbPatch = async (path, body) => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: { ...sbHeaders, Prefer: 'return=representation' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase PATCH ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
};

// ── WERKDAG-BEREKENING ──────────────────────────────────────────────
// Geeft het aantal werkuren (ma-vr) tussen twee tijdstippen, in Europe/Amsterdam.
// Vrijdag 14:00 → maandag 14:00 = 24 werkuren (weekend telt niet)
function werkurenTussen(vanaf, tot) {
  // Werkdagen: ma=1, di=2, wo=3, do=4, vr=5
  let uren = 0;
  const cursor = new Date(vanaf.getTime());
  while (cursor < tot) {
    const dow = cursor.getUTCDay(); // 0=zo, 1=ma, ..., 6=za
    // Stap: 1 uur vooruit
    const volgende = new Date(cursor.getTime() + 60 * 60 * 1000);
    if (volgende > tot) {
      // Laatste stap: deelvolledig uur
      if (dow >= 1 && dow <= 5) {
        uren += (tot - cursor) / (60 * 60 * 1000);
      }
      break;
    }
    if (dow >= 1 && dow <= 5) uren += 1;
    cursor.setTime(volgende.getTime());
  }
  return uren;
}

// ── MAIL HELPER ─────────────────────────────────────────────────────
async function stuurMail({ to, subject, html }) {
  if (!RESEND_API_KEY) {
    console.warn('[herinnering] RESEND_API_KEY ontbreekt — mail niet verstuurd');
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
      console.error(`[herinnering] Resend ${res.status}: ${txt}`);
      return { ok: false, reason: `http_${res.status}` };
    }
    const json = await res.json();
    console.log(`[herinnering] verstuurd naar ${to} (id=${json.id})`);
    return { ok: true, id: json.id };
  } catch (err) {
    console.error('[herinnering] uitzondering:', err.message);
    return { ok: false, reason: 'exception' };
  }
}

// ── MAIL TEMPLATE ───────────────────────────────────────────────────
function renderHerinneringMail({
  niveau, // 1 of 2
  ontvangerNaam, klantNaam, adres, telefoon, email,
  gevendeMakelaar, opmerking, dagenGeleden, leadpoolUrl,
}) {
  const esc = s => String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
  const veiligeTel = esc(telefoon || '—');
  const veiligEmail = esc(email || '—');

  const titel = niveau === 1
    ? '⏰ Vergeten te bellen?'
    : '⏰ Lead wacht nog steeds';

  const intro = niveau === 1
    ? `Hoi ${esc(ontvangerNaam)}, gisteren heb je een lead uit de pool gekregen — ${esc(klantNaam)}. Volgens ons systeem heb je nog niet gebeld. Even reminder!`
    : `Hoi ${esc(ontvangerNaam)}, ${esc(klantNaam)} is nu ${dagenGeleden} werkdagen geleden aan jou toegewezen en is nog steeds niet gebeld. Tijd om te bellen of door te geven aan een collega.`;

  const opmerkingBlok = opmerking
    ? `<tr><td style="padding:8px 0;color:#64748b;font-size:13px;width:140px">Opmerking</td>
         <td style="padding:8px 0;color:#1A2B5F;font-size:14px;font-style:italic">${esc(opmerking)}</td></tr>`
    : '';

  const headerKleur = niveau === 1 ? '#1A2B5F' : '#991b1b';

  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f4f6fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f4f6fa;padding:24px 0">
    <tr><td align="center">
      <table cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden">
        <tr><td style="background:${headerKleur};padding:20px 24px;color:white">
          <div style="font-size:12px;letter-spacing:0.05em;opacity:0.8;text-transform:uppercase">MVA Leadpool · Herinnering</div>
          <div style="font-size:20px;font-weight:700;margin-top:4px">${titel}</div>
        </td></tr>
        <tr><td style="padding:24px">
          <div style="font-size:15px;color:#1A2B5F;margin-bottom:18px">
            ${intro}
          </div>
          <table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse">
            <tr><td style="padding:8px 0;color:#64748b;font-size:13px;width:140px">Klant</td>
                <td style="padding:8px 0;color:#1A2B5F;font-size:15px;font-weight:600">${esc(klantNaam)}</td></tr>
            <tr><td style="padding:8px 0;color:#64748b;font-size:13px">Adres bezichtiging</td>
                <td style="padding:8px 0;color:#1A2B5F;font-size:14px">${esc(adres)}</td></tr>
            <tr><td style="padding:8px 0;color:#64748b;font-size:13px">Telefoon</td>
                <td style="padding:8px 0;color:#1A2B5F;font-size:14px"><a href="tel:${veiligeTel}" style="color:#E8500A;text-decoration:none">${veiligeTel}</a></td></tr>
            <tr><td style="padding:8px 0;color:#64748b;font-size:13px">Email</td>
                <td style="padding:8px 0;color:#1A2B5F;font-size:14px"><a href="mailto:${veiligEmail}" style="color:#E8500A;text-decoration:none">${veiligEmail}</a></td></tr>
            <tr><td style="padding:8px 0;color:#64748b;font-size:13px">Doorgegeven door</td>
                <td style="padding:8px 0;color:#1A2B5F;font-size:14px">${esc(gevendeMakelaar)}</td></tr>
            ${opmerkingBlok}
          </table>
          <div style="margin-top:24px;padding:16px;background:#fef9c3;border-left:3px solid #ca8a04;border-radius:4px">
            <div style="font-size:13px;color:#713f12;line-height:1.5">
              <strong>Twee opties:</strong><br>
              1. Bel ${esc(klantNaam)} alsnog, of<br>
              2. Open de Leadpool-app en geef de lead door aan een collega.
            </div>
          </div>
          <div style="margin-top:20px;text-align:center">
            <a href="${leadpoolUrl}" style="display:inline-block;background:#E8500A;color:white;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;font-size:14px">
              Open in Leadpool →
            </a>
          </div>
          <div style="margin-top:24px;padding-top:16px;border-top:1px solid #e2e8f0;font-size:12px;color:#94a3b8;text-align:center">
            ${niveau === 2
              ? 'Dit is je tweede herinnering. Daarna sturen we geen mails meer voor deze lead.'
              : 'Geen actie nodig als je intussen al hebt gebeld — zet dan even de status in de app.'}
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
  const nu = new Date();
  console.log(`[herinnering] check gestart op ${nu.toISOString()}`);

  let aantal1 = 0, aantal2 = 0, fouten = 0;

  try {
    // Haal alle openstaande leads op die mogelijk een herinnering nodig hebben.
    // Filter: belstatus 'nieuw', belpogingen=0, met eigenaar.
    // We sluiten ook leads uit die al twee herinneringen kregen (efficiency).
    const items = await sbGet(
      `bellijst_items?` +
      `select=id,eigenaar_id,bezichtiging_id,bezichtiger_naam,adres,bezichtiger_telefoon,bezichtiger_email,opmerking,toegevoegd_op,herinnering_1_verzonden_op,herinnering_2_verzonden_op&` +
      `bel_status=eq.nieuw&belpogingen=eq.0&` +
      `eigenaar_id=not.is.null&` +
      `herinnering_2_verzonden_op=is.null`
    );

    console.log(`[herinnering] ${items.length} kandidaten gevonden`);

    for (const item of items) {
      try {
        if (!item.toegevoegd_op) continue;
        const toegewezen = new Date(item.toegevoegd_op);
        const werkuren = werkurenTussen(toegewezen, nu);

        // Niveau 2 check eerst — als die nodig is hoeft niveau 1 niet meer
        const heeftHerinnering1 = !!item.herinnering_1_verzonden_op;
        const heeftHerinnering2 = !!item.herinnering_2_verzonden_op;

        let teVerzendenNiveau = null;
        if (!heeftHerinnering2 && werkuren >= 48 && heeftHerinnering1) {
          teVerzendenNiveau = 2;
        } else if (!heeftHerinnering1 && werkuren >= 24) {
          teVerzendenNiveau = 1;
        }

        if (!teVerzendenNiveau) continue;

        // Haal ontvangende makelaar op
        const eigenaarRows = await sbGet(
          `gebruikers?select=naam,email&id=eq.${item.eigenaar_id}`
        );
        if (!eigenaarRows[0]?.email) {
          console.warn(`[herinnering] item ${item.id}: geen eigenaar-email`);
          continue;
        }
        const eigenaar = eigenaarRows[0];

        // Haal gevende makelaar op via bezichtiging
        let gevendeMakelaar = 'een collega';
        if (item.bezichtiging_id) {
          try {
            const bezRows = await sbGet(
              `bezichtigingen?select=gevende_makelaar_id&id=eq.${item.bezichtiging_id}`
            );
            if (bezRows[0]?.gevende_makelaar_id) {
              const gRows = await sbGet(
                `gebruikers?select=naam&id=eq.${bezRows[0].gevende_makelaar_id}`
              );
              if (gRows[0]?.naam) gevendeMakelaar = gRows[0].naam;
            }
          } catch { /* niet kritiek */ }
        }

        const dagenGeleden = Math.floor(werkuren / 24);

        const html = renderHerinneringMail({
          niveau:          teVerzendenNiveau,
          ontvangerNaam:   eigenaar.naam,
          klantNaam:       item.bezichtiger_naam || 'Onbekend',
          adres:           item.adres || '—',
          telefoon:        item.bezichtiger_telefoon || '',
          email:           item.bezichtiger_email || '',
          gevendeMakelaar,
          opmerking:       item.opmerking || '',
          dagenGeleden,
          leadpoolUrl:     'https://mvaleadpool.netlify.app/',
        });

        const onderwerp = teVerzendenNiveau === 1
          ? `Herinnering: ${item.bezichtiger_naam || 'lead'} nog niet gebeld`
          : `2e herinnering: ${item.bezichtiger_naam || 'lead'} wacht nog steeds`;

        const mailResult = await stuurMail({
          to: eigenaar.email,
          subject: onderwerp,
          html,
        });

        // Push naast de mail. Onafhankelijk van mailResult: push en mail zijn
        // aparte kanalen. Deeplink opent de lead direct in de bellijst.
        await pushNaarMakelaar(eigenaar.email, {
          title: teVerzendenNiveau === 1
            ? '⏰ Vergeten te bellen?'
            : '⏰ Lead wacht nog steeds',
          body:  `${item.bezichtiger_naam || 'Een lead'} · ${item.adres || ''}`.trim(),
          url:   `/?lead=${item.id}`,
        });

        if (mailResult.ok) {
          // Markeer dat herinnering is verstuurd
          const updateVeld = teVerzendenNiveau === 1
            ? 'herinnering_1_verzonden_op'
            : 'herinnering_2_verzonden_op';
          await sbPatch(`bellijst_items?id=eq.${item.id}`, {
            [updateVeld]: new Date().toISOString(),
          });
          if (teVerzendenNiveau === 1) aantal1++; else aantal2++;
        } else {
          fouten++;
        }
      } catch (e) {
        console.error(`[herinnering] item ${item.id} faalde:`, e.message);
        fouten++;
      }
    }

    const duurMs = Date.now() - start;
    console.log(`[herinnering] klaar in ${duurMs}ms — N1: ${aantal1}, N2: ${aantal2}, fouten: ${fouten}`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        gecontroleerd: items.length,
        verstuurd_niveau_1: aantal1,
        verstuurd_niveau_2: aantal2,
        fouten,
        duur_ms: duurMs,
      }),
    };
  } catch (err) {
    console.error('[herinnering] FATAL:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

// Schedule wordt geregistreerd in netlify.toml (elke 15 minuten).
