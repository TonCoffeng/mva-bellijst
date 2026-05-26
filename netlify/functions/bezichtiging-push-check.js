// netlify/functions/bezichtiging-push-check.js
// ─────────────────────────────────────────────────────────────────────────────
// SCHEDULED FUNCTION — draait elke 5 minuten.
//
// Doel: stuur de GEVENDE makelaar (wie de bezichtiging draait) een push vlak
// vóór de geplande bezichtigingstijd, zodat hij de kaart meteen kan openen en
// na afloop direct feedback kan geven.
//
// Trigger: bezichtigingen waarvan datum_tijd binnen het venster
//   [nu, nu + 5 minuten]  valt — dus de bezichtiging begint binnen 0–5 min.
//
// Voorwaarden:
//   - type = 'ingepland'   (open huizen niet — die werken via QR-inschrijving)
//   - gearchiveerd = false
//   - bezichtiging_push_verzonden_op IS NULL  (eenmalig)
//   - gevende_makelaar_id gezet
//
// Eenmalig: na verzenden zetten we bezichtiging_push_verzonden_op = now(), zodat
// de volgende 5-minuten-run dezelfde bezichtiging niet opnieuw pakt.
//
// Push loopt via de gedeelde helper push-send.js (zelfde VAPID-config als de
// lead-pushes). Faalt stilletjes — een push-fout mag niets blokkeren.
//
// Cron-schedule staat in netlify.toml (*/5 * * * *).
// ─────────────────────────────────────────────────────────────────────────────

const { pushNaarMakelaar } = require('./push-send');

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Hoe ver vooruit kijken we? Bezichtigingen die binnen dit venster starten
// krijgen nu hun push. 5 min sluit aan op het cron-ritme (elke 5 min draaien).
const VENSTER_MINUTEN = 5;

const sbHeaders = {
  apikey:         SUPABASE_SERVICE_KEY,
  Authorization:  `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json',
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

// Leesbare tijd (HH:MM) in Europe/Amsterdam voor in de push-tekst.
function tijdLabel(iso) {
  try {
    return new Date(iso).toLocaleTimeString('nl-NL', {
      hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam',
    });
  } catch { return ''; }
}

exports.handler = async () => {
  const start = Date.now();
  const nu = new Date();
  const grens = new Date(nu.getTime() + VENSTER_MINUTEN * 60 * 1000);
  console.log(`[bez-push] check ${nu.toISOString()} → venster tot ${grens.toISOString()}`);

  let verstuurd = 0, overgeslagen = 0, fouten = 0;

  try {
    // Bezichtigingen die binnen [nu, nu+venster] starten, ingepland, niet
    // gearchiveerd, nog geen push gehad.
    const items = await sbGet(
      `bezichtigingen?` +
      `select=id,bezichtiger_naam,adres,datum_tijd,gevende_makelaar_id,type,gearchiveerd,bezichtiging_push_verzonden_op&` +
      `type=eq.ingepland&` +
      `gearchiveerd=eq.false&` +
      `bezichtiging_push_verzonden_op=is.null&` +
      `gevende_makelaar_id=not.is.null&` +
      `datum_tijd=gte.${encodeURIComponent(nu.toISOString())}&` +
      `datum_tijd=lte.${encodeURIComponent(grens.toISOString())}`
    );

    console.log(`[bez-push] ${items.length} bezichtiging(en) in venster`);

    for (const bez of items) {
      try {
        // Haal de gevende makelaar (naam + e-mail; e-mail = push-sleutel)
        const mRows = await sbGet(
          `gebruikers?select=naam,email&id=eq.${bez.gevende_makelaar_id}`
        );
        const makelaar = mRows[0];
        if (!makelaar?.email) {
          console.warn(`[bez-push] bez ${bez.id}: geen makelaar-email`);
          overgeslagen++;
          // Toch markeren zou de bezichtiging "verbranden"; we laten 'm staan
          // zodat een volgende run het opnieuw kan proberen als de data klopt.
          continue;
        }

        const tijd = tijdLabel(bez.datum_tijd);
        await pushNaarMakelaar(makelaar.email, {
          title: '📅 Bezichtiging begint zo',
          body:  `${tijd ? tijd + ' · ' : ''}${bez.bezichtiger_naam || 'bezichtiger'} · ${bez.adres || ''}`.trim(),
          url:   `/?bez=${bez.id}`,
        });

        // Eenmalig markeren — ongeacht of er een actieve subscription was.
        // (Geen subscription = push-helper geeft netjes 'geen_subscription'
        //  terug; we willen 'm dan niet elke 5 min opnieuw proberen voor een
        //  bezichtiging die intussen al begonnen is.)
        await sbPatch(`bezichtigingen?id=eq.${bez.id}`, {
          bezichtiging_push_verzonden_op: new Date().toISOString(),
        });
        verstuurd++;
      } catch (e) {
        console.error(`[bez-push] bez ${bez.id} faalde:`, e.message);
        fouten++;
      }
    }

    const duurMs = Date.now() - start;
    console.log(`[bez-push] klaar in ${duurMs}ms — verstuurd: ${verstuurd}, overgeslagen: ${overgeslagen}, fouten: ${fouten}`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        in_venster: items.length,
        verstuurd, overgeslagen, fouten,
        duur_ms: duurMs,
      }),
    };
  } catch (err) {
    console.error('[bez-push] FATAL:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

// Schedule staat in netlify.toml (*/5 * * * *).
