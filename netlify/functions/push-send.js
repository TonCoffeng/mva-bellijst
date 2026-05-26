// netlify/functions/push-send.js
// ─────────────────────────────────────────────────────────────────────────────
// Herbruikbare push-verzender voor de MVA Leadpool.
//
// Eén plek voor alle web-push-logica. Geïmporteerd door:
//   - monday.js            (push bij nieuwe pool-lead + doorgegeven lead)
//   - herinnering-check.js (push bij herinnering 1 & 2)
//
// Loopt NAAST de bestaande Resend-mail, op exact dezelfde momenten. Een push-
// fout mag — net als een mailfout — nooit een lead-actie blokkeren: alle
// functies hieronder vangen hun eigen fouten af en geven een resultaat-object
// terug i.p.v. te throwen.
//
// Vereiste Netlify env vars:
//   VAPID_PUBLIC_KEY   — moet matchen met de key in public/index.html
//   VAPID_PRIVATE_KEY  — geheim; hoort bij de public key
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY
//
// Subscriptions staan in Supabase-tabel `push_subscriptions`, één rij per
// makelaar (uniek op makelaar_email), gevuld door push-subscribe.js.
// ─────────────────────────────────────────────────────────────────────────────

const webpush = require('web-push');

const VAPID_PUBLIC_KEY   = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY  = process.env.VAPID_PRIVATE_KEY;
const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// VAPID-contact: een mailto die push-services kunnen gebruiken bij problemen.
const VAPID_SUBJECT = 'mailto:contact@makelaarsvan.nl';

let vapidGeconfigureerd = false;
function configureerVapid() {
  if (vapidGeconfigureerd) return true;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    console.warn('[push] VAPID-keys ontbreken — push niet verstuurd');
    return false;
  }
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  vapidGeconfigureerd = true;
  return true;
}

const sbHeaders = {
  apikey:         SUPABASE_SERVICE_KEY,
  Authorization:  `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

// Haalt de opgeslagen subscription op voor één makelaar (op e-mail).
async function haalSubscription(email) {
  const url = `${SUPABASE_URL}/rest/v1/push_subscriptions` +
    `?select=makelaar_email,subscription&makelaar_email=eq.${encodeURIComponent(email)}`;
  const res = await fetch(url, { headers: sbHeaders });
  if (!res.ok) {
    console.error(`[push] Supabase GET → ${res.status}: ${await res.text()}`);
    return null;
  }
  const rows = await res.json();
  if (!rows[0]?.subscription) return null;
  try {
    // subscription staat als JSON-string opgeslagen (zie push-subscribe.js)
    return JSON.parse(rows[0].subscription);
  } catch (e) {
    console.error(`[push] subscription-parse faalde voor ${email}:`, e.message);
    return null;
  }
}

// Verwijdert een dode subscription (HTTP 404/410 van de push-service betekent:
// de gebruiker heeft uitgeschreven of de subscription is verlopen).
async function verwijderSubscription(email) {
  try {
    const url = `${SUPABASE_URL}/rest/v1/push_subscriptions` +
      `?makelaar_email=eq.${encodeURIComponent(email)}`;
    await fetch(url, { method: 'DELETE', headers: sbHeaders });
    console.log(`[push] dode subscription verwijderd voor ${email}`);
  } catch (e) {
    console.warn(`[push] kon dode subscription niet verwijderen voor ${email}:`, e.message);
  }
}

// ── PUBLIEKE HELPER ─────────────────────────────────────────────────
// Stuurt één push naar één makelaar. Faalt nooit hard.
//
//   email  — makelaar_email (zelfde adres als waar de mail heen gaat)
//   title  — notificatie-titel
//   body   — notificatie-tekst
//   url    — deeplink die de SW opent bij tik (bv. '/?lead=123')
//
// Retourneert { ok, reason? } — puur informatief voor de logs.
async function pushNaarMakelaar(email, { title, body, url = '/' }) {
  if (!email) return { ok: false, reason: 'geen_email' };
  if (!configureerVapid()) return { ok: false, reason: 'geen_vapid' };
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.warn('[push] Supabase-config ontbreekt — push niet verstuurd');
    return { ok: false, reason: 'geen_supabase' };
  }

  const subscription = await haalSubscription(email);
  if (!subscription) {
    // Geen abonnement = makelaar heeft push (nog) niet aangezet. Normaal, geen fout.
    return { ok: false, reason: 'geen_subscription' };
  }

  const payload = JSON.stringify({ title, body, url });

  try {
    await webpush.sendNotification(subscription, payload);
    console.log(`[push] verstuurd naar ${email}: ${title}`);
    return { ok: true };
  } catch (err) {
    const status = err?.statusCode;
    if (status === 404 || status === 410) {
      // Subscription bestaat niet meer → opruimen zodat we het niet blijven proberen.
      await verwijderSubscription(email);
      return { ok: false, reason: 'subscription_verlopen' };
    }
    console.error(`[push] verzenden faalde voor ${email} (status=${status}):`, err.message);
    return { ok: false, reason: 'verzend_fout', status };
  }
}

module.exports = { pushNaarMakelaar };
