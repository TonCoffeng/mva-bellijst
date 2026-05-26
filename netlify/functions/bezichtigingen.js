// netlify/functions/bezichtigingen.js
// ─────────────────────────────────────────────────────────────────────
// Doel: vervang Monday's get_bezichtigingen met directe Supabase query.
// Leest uit MVA-Roundrobin project (olfcrzusdkijxroxvsgm).
//
// Input  (POST body): { data: { makelaar_email: '...' } }
// Output (JSON)     : { bezichtigingen: [...] }
// Output structuur is identiek aan Monday's get_bezichtigingen voor
// backwards compat met index.html frontend.
// ─────────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Supabase env vars ontbreken' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const makelaarEmail = (payload?.data?.makelaar_email || payload?.makelaar_email || '').toLowerCase().trim();
  if (!makelaarEmail) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'makelaar_email ontbreekt in body' }) };
  }

  try {
    // Stap 1: zoek gebruiker-id op basis van email
    const userRes = await fetch(
      `${SUPABASE_URL}/rest/v1/gebruikers?email=eq.${encodeURIComponent(makelaarEmail)}&select=id,naam,rol,actief`,
      {
        headers: {
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        },
      }
    );
    if (!userRes.ok) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Supabase gebruiker-lookup faalde', status: userRes.status }) };
    }
    const users = await userRes.json();
    if (!users.length) {
      return { statusCode: 200, headers, body: JSON.stringify({ bezichtigingen: [], info: 'gebruiker niet gevonden' }) };
    }
    const user = users[0];
    if (!user.actief) {
      return { statusCode: 200, headers, body: JSON.stringify({ bezichtigingen: [], info: 'gebruiker niet actief' }) };
    }

    // Stap 2: haal bezichtigingen op voor deze makelaar (alleen niet-gearchiveerde)
    const bezRes = await fetch(
      `${SUPABASE_URL}/rest/v1/bezichtigingen?gevende_makelaar_id=eq.${user.id}&gearchiveerd=eq.false&select=*&order=datum_tijd.desc`,
      {
        headers: {
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        },
      }
    );
    if (!bezRes.ok) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Supabase bezichtigingen-fetch faalde', status: bezRes.status }) };
    }
    const rows = await bezRes.json();

    // Filter lege placeholder-slots eruit (Realworks Bezichtigingsplanner
    // levert ook lege "+ Relatie koppelen" tijdslots door — geen naam, geen
    // email, geen telefoon. Niets om feedback over te geven, dus verbergen.)
    const isLegeSlot = (b) =>
      !((b.bezichtiger_naam || '').trim()) &&
      !((b.bezichtiger_email || '').trim()) &&
      !((b.bezichtiger_telefoon || '').trim());

    const gefilterdeRows = rows.filter(r => !isLegeSlot(r));

    // Stap 2b: BEZOEKTELLER + FEEDBACK-HISTORIE ───────────────────────
    // Rogier-vraag: "hoe vaak komen mensen per woning langs, en staat de
    // feedback van de vorige keer er ook?" We tellen over ALLE bezichtigingen
    // heen (alle makelaars, ook gearchiveerd), gematcht op e-mail (voorkeur)
    // of telefoon — bewust niet op naam (spelling varieert). Twee tellingen:
    //   - bezoeken_totaal:    hoe vaak deze persoon ergens is geweest
    //   - bezoeken_dit_adres: hoe vaak bij DIT specifieke adres
    // Plus de feedback van eerdere bezoeken aan dit adres. Eén extra query,
    // daarna in-memory tellen — geen query-per-kaart. Faalt stil (niet kritiek).
    const persoonSleutel = (email, tel) => {
      const e = (email || '').trim().toLowerCase();
      if (e) return `e:${e}`;
      const t = (tel || '').replace(/[^0-9+]/g, '');
      if (t) return `t:${t}`;
      return null;
    };
    const adresSleutel = (adres) =>
      (adres || '').trim().toLowerCase().replace(/\s+/g, ' ');

    const bezoekenTotaal = {};            // sleutel -> count
    const bezoekenPerPersoonAdres = {};   // `${sleutel}||${adres}` -> count
    const historiePerPersoonAdres = {};   // `${sleutel}||${adres}` -> [{...}]
    try {
      const alleRes = await fetch(
        `${SUPABASE_URL}/rest/v1/bezichtigingen?select=id,bezichtiger_email,bezichtiger_telefoon,adres,datum_tijd,feedback_keys,feedback_opmerking&order=datum_tijd.asc&limit=5000`,
        {
          headers: {
            'apikey': SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          },
        }
      );
      if (alleRes.ok) {
        const alle = await alleRes.json();
        for (const b of alle) {
          const sl = persoonSleutel(b.bezichtiger_email, b.bezichtiger_telefoon);
          if (!sl) continue;
          bezoekenTotaal[sl] = (bezoekenTotaal[sl] || 0) + 1;
          const combo = `${sl}||${adresSleutel(b.adres)}`;
          bezoekenPerPersoonAdres[combo] = (bezoekenPerPersoonAdres[combo] || 0) + 1;
          const heeftFb = Array.isArray(b.feedback_keys) && b.feedback_keys.length > 0;
          const heeftOpm = !!(b.feedback_opmerking || '').trim();
          if (heeftFb || heeftOpm) {
            (historiePerPersoonAdres[combo] = historiePerPersoonAdres[combo] || []).push({
              bez_id:    String(b.id),
              datum:     b.datum_tijd ? b.datum_tijd.slice(0, 10) : '',
              feedback:  Array.isArray(b.feedback_keys) ? b.feedback_keys : [],
              opmerking: b.feedback_opmerking || '',
            });
          }
        }
      }
    } catch (e) {
      // bezoekteller is een extraatje — nooit de hoofdrespons laten falen
      console.warn('[bezichtigingen] bezoekteller faalde (niet kritiek):', e.message);
    }

    // Stap 3: map naar Monday-style output (zodat frontend code ongewijzigd blijft)
    const bezichtigingen = gefilterdeRows.map(row => {
      // Splits datum_tijd naar datum + tijdstip in Europe/Amsterdam tijdzone
      let datum = null;
      let tijdstip = null;
      if (row.datum_tijd) {
        try {
          const dt = new Date(row.datum_tijd);
          // Datum in YYYY-MM-DD (Europe/Amsterdam)
          const datumStr = dt.toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
          datum = datumStr;
          // Tijdstip in HH:MM (Europe/Amsterdam)
          tijdstip = dt.toLocaleTimeString('nl-NL', {
            timeZone: 'Europe/Amsterdam',
            hour: '2-digit',
            minute: '2-digit',
          });
        } catch {
          datum = row.datum_tijd.slice(0, 10);
          tijdstip = row.datum_tijd.slice(11, 16);
        }
      }

      const status = (row.actie_status || '').toLowerCase();
      const inPool = (status === 'pool');

      // Open-huis-bezoeker mag alleen doorgestuurd worden als de ingelogde
      // (verkopend) makelaar het open huis ZELF draaide. Ander draaide →
      // kaart is ter info, geen doorstuur/zelf-bellen/toewijzen-knoppen.
      const type = row.type || 'ingepland';
      const magDoorsturen = (type === 'open_huis_bezoeker')
        ? (row.open_huis_door_id === user.id)
        : true;

      // Bezoekteller-velden voor deze bezichtiger
      const sl = persoonSleutel(row.bezichtiger_email, row.bezichtiger_telefoon);
      const combo = sl ? `${sl}||${adresSleutel(row.adres)}` : null;
      const bezoekenTot  = sl ? (bezoekenTotaal[sl] || 0) : 0;
      const bezoekenAdr  = combo ? (bezoekenPerPersoonAdres[combo] || 0) : 0;
      // Eerdere feedback aan dit adres — exclusief de huidige bezichtiging zelf,
      // oudste eerst, en zonder lege entries.
      const eerdereFeedback = (combo ? (historiePerPersoonAdres[combo] || []) : [])
        .filter(h => h.bez_id !== String(row.id));

      return {
        id: String(row.id),  // database primary key — matcht monday.js queries (push_naar_pool, push_naar_eigen_bellijst, etc.)
        realworks_id: row.realworks_id || null,  // beschikbaar als referentie maar niet als hoofdkey
        naam: row.bezichtiger_naam || '',
        adres: row.adres || '',
        makelaar: user.naam,
        datum,
        tijdstip,
        telefoon: row.bezichtiger_telefoon || '',
        email: row.bezichtiger_email || '',
        niet_naar_pool: (status === 'zelf' || status === 'afgehandeld'),
        doorgegeven: inPool,
        gearchiveerd: !!row.gearchiveerd,
        feedback: Array.isArray(row.feedback_keys) ? row.feedback_keys.join(',') : (row.feedback_keys || ''),
        opmerking: row.feedback_opmerking || '',
        in_pool: inPool,
        actie_status: status === 'open' ? '' : status,  // '' betekent "nog geen actie" voor frontend
        type,
        publieke_token: row.publieke_token || null,
        open_huis_door_id: row.open_huis_door_id || null,
        mag_doorsturen: magDoorsturen,
        bezoeken_totaal: bezoekenTot,
        bezoeken_dit_adres: bezoekenAdr,
        eerdere_feedback: eerdereFeedback,
      };
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ bezichtigingen }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Server error', message: err.message }),
    };
  }
};
