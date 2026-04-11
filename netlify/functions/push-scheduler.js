// Netlify Scheduled Function: push-scheduler.js
// Draait elke 15 minuten — checkt welke bezichtigingen net zijn begonnen
// en stuurt automatisch een push naar de verantwoordelijke makelaar

const { schedule } = require('@netlify/functions');
const webpush = require('web-push');
const { createClient } = require('@supabase/supabase-js');

const handler = async () => {
  try {
    const MONDAY_TOKEN = process.env.MONDAY_TOKEN;
    const token = MONDAY_TOKEN.startsWith('Bearer ') ? MONDAY_TOKEN : `Bearer ${MONDAY_TOKEN}`;

    webpush.setVapidDetails(
      'mailto:toncoffeng@makelaarsvan.nl',
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    // Haal alle bezichtigingen op van vandaag uit monday
    const nu = new Date();
    const vandaag = nu.toISOString().split('T')[0]; // "2026-04-11"

    const mondayRes = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: token, 'API-Version': '2024-01' },
      body: JSON.stringify({
        query: `{
          boards(ids: [5093190482]) {
            items_page(limit: 100) {
              items {
                id name
                column_values { id text value }
              }
            }
          }
        }`
      })
    });

    const mondayData = await mondayRes.json();
    const items = mondayData?.data?.boards?.[0]?.items_page?.items || [];

    // Filter bezichtigingen van vandaag
    const bezichtigingenVandaag = items
      .map(item => {
        const cols = item.column_values || [];
        const get = (id) => cols.find(c => c.id === id)?.text || '';
        const getVal = (id) => {
          const raw = cols.find(c => c.id === id)?.value;
          try { return raw ? JSON.parse(raw) : null; } catch { return null; }
        };

        const datumVal = getVal('date_mm1fn58e');
        const datum = datumVal?.date || '';
        const tijdstip = datumVal?.time ? datumVal.time.substring(0, 5) : null;

        return {
          id: item.id,
          naam: item.name,
          adres: get('text_mm1ff7f1'),
          makelaar: get('text_mm1f3x0n'),
          datum,
          tijdstip,
          al_gepusht: get('text_mm1fy05p')?.includes('GEPUSHT') || false,
        };
      })
      .filter(b => b.datum === vandaag && b.tijdstip && b.makelaar && !b.al_gepusht);

    console.log(`Vandaag ${bezichtigingenVandaag.length} bezichtigingen gevonden`);

    // Stuur push voor bezichtigingen die nu beginnen (binnen 5 minuten)
    const verzonden = [];

    for (const bez of bezichtigingenVandaag) {
      const [uur, min] = bez.tijdstip.split(':').map(Number);
      const bezTijd = new Date(nu);
      bezTijd.setHours(uur, min, 0, 0);

      const verschilMin = (bezTijd - nu) / 60000;

      // Stuur push als bezichtiging binnen 5 min begint of net begonnen is (0-15 min geleden)
      if (verschilMin >= -15 && verschilMin <= 5) {
        // Zoek email van makelaar in Meedoen Leadpool
        const makelaarsRes = await fetch('https://api.monday.com/v2', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: token, 'API-Version': '2024-01' },
          body: JSON.stringify({
            query: `{ boards(ids: [5093235823]) { items_page(limit: 50) { items { name column_values { id text } } } } }`
          })
        });

        const makelaarsData = await makelaarsRes.json();
        const makelaars = makelaarsData?.data?.boards?.[0]?.items_page?.items || [];
        const makelaarItem = makelaars.find(m => m.name.toLowerCase() === bez.makelaar.toLowerCase());
        const makelaarEmail = makelaarItem?.column_values?.find(c => c.id === 'text_mm1nxwsn')?.text;

        if (!makelaarEmail) {
          console.log(`Geen email gevonden voor makelaar: ${bez.makelaar}`);
          continue;
        }

        // Haal subscription op
        const { data: subData } = await supabase
          .from('push_subscriptions')
          .select('subscription')
          .eq('makelaar_email', makelaarEmail)
          .single();

        if (!subData) {
          console.log(`Geen push subscription voor: ${makelaarEmail}`);
          continue;
        }

        // Stuur de push
        try {
          const subscription = JSON.parse(subData.subscription);
          await webpush.sendNotification(subscription, JSON.stringify({
            title: `🏠 Bezichtiging: ${bez.naam}`,
            body: `${bez.tijdstip} · ${bez.adres}\nTik om feedback te geven`,
            url: '/?geven=1',
            icon: '/icon-192.png',
          }));

          verzonden.push({ makelaar: bez.makelaar, klant: bez.naam });
          console.log(`Push verstuurd naar ${bez.makelaar} voor bezichtiging ${bez.naam}`);
        } catch (pushErr) {
          console.error(`Push mislukt voor ${makelaarEmail}:`, pushErr.message);
        }
      }
    }

    return { statusCode: 200, body: JSON.stringify({ verzonden, totaal: bezichtigingenVandaag.length }) };
  } catch (err) {
    console.error('Scheduler error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

// Elke 15 minuten
exports.handler = schedule('*/15 * * * *', handler);
// Supabase tabel die nodig is:
// CREATE TABLE push_subscriptions (
//   id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
//   makelaar_email text UNIQUE NOT NULL,
//   makelaar_naam text,
//   subscription text NOT NULL,
//   updated_at timestamptz DEFAULT now()
// );
