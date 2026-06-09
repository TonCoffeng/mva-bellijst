// netlify/functions/intake.js
// ──────────────────────────────────────────────────────────────────────────
// Intake-koppeling op de centrale kern (Supabase-project Leadpool).
//
// Maakt (of hergebruikt via dedup) een klant en opent een dossier dat is
// toegewezen aan een makelaar, met de juiste rol-koppeling. De database-trigger
// vult daarna automatisch klant_makelaar_toegang → Chinese walls staan meteen goed.
//
// Input (POST JSON):
//   {
//     dienst,                      // Verkoop | Aankoop | Verhuur | Aanhuur
//     naam?  |  voornaam?, achternaam?,
//     email?, telefoon?,           // minimaal één van beide
//     adres?, postcode?, plaats?,
//     makelaar_id                  // bigint, gebruikers.id van de toegewezen makelaar
//   }
//
// Output: { ok, klant_id, dossier_id, klant_hergebruikt }
// ──────────────────────────────────────────────────────────────────────────

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

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

const sbInsert = async (path, body) => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: { ...sbHeaders, Prefer: 'return=representation' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase POST ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
};

// dienst → [dossier_type, partij_rol]
const DIENST_MAP = {
  Verkoop: ['verkoop', 'verkoper'],
  Aankoop: ['aankoop', 'koper'],
  Verhuur: ['verhuur', 'verhuurder'],
  Aanhuur: ['aanhuur', 'huurder'],
};

const splitNaam = (naam) => {
  const parts = (naam || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { voornaam: parts[0] || '', achternaam: '' };
  return { voornaam: parts[0], achternaam: parts.slice(1).join(' ') };
};

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type':                 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  // ── GET: makelaarslijst voor het formulier-dropdown ──
  if (event.httpMethod === 'GET') {
    try {
      const makelaars = await sbGet(
        `gebruikers?select=id,naam&actief=eq.true&rol=in.(makelaar,makelaar-mentor,directie)&order=naam.asc`
      );
      return { statusCode: 200, headers, body: JSON.stringify({ makelaars }) };
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
  }

  try {
    const b = JSON.parse(event.body || '{}');

    // ── Validatie ──
    const dienst = b.dienst;
    if (!DIENST_MAP[dienst]) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Ongeldige of ontbrekende dienst (Verkoop/Aankoop/Verhuur/Aanhuur)' }) };
    }
    const makelaarId = b.makelaar_id;
    if (!makelaarId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'makelaar_id is verplicht' }) };
    }
    const email    = (b.email    || '').trim();
    const telefoon = (b.telefoon || '').trim();
    if (!email && !telefoon) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Minimaal e-mail of telefoon is verplicht' }) };
    }

    const [dossierType, rol] = DIENST_MAP[dienst];

    // ── 1. Dedup: bestaande klant zoeken (e-mail eerst, dan telefoon) ──
    let klant = null;
    if (email) {
      const hit = await sbGet(`klanten?select=id&email=ilike.${encodeURIComponent(email)}&limit=1`);
      if (hit.length) klant = hit[0];
    }
    if (!klant && telefoon) {
      const hit = await sbGet(`klanten?select=id&telefoon=eq.${encodeURIComponent(telefoon)}&limit=1`);
      if (hit.length) klant = hit[0];
    }
    const klantHergebruikt = !!klant;

    // ── 2. Klant aanmaken indien nieuw ──
    if (!klant) {
      const naam = b.naam
        ? splitNaam(b.naam)
        : { voornaam: b.voornaam || '', achternaam: b.achternaam || '' };
      const ins = await sbInsert('klanten', {
        type:       'natuurlijk_persoon',
        voornaam:   naam.voornaam   || null,
        achternaam: naam.achternaam || null,
        email:      email    || null,
        telefoon:   telefoon || null,
        adres:      b.adres    || null,
        postcode:   b.postcode || null,
        plaats:     b.plaats   || null,
        bron:       'portal_intake',
      });
      klant = ins[0];
    }

    // ── 3. Dossier openen, toegewezen aan de makelaar ──
    const dosIns = await sbInsert('dossiers', {
      type:         dossierType,
      makelaar_id:  makelaarId,
      object_adres: b.adres || null,
      status:       'actief',
    });
    const dossier = dosIns[0];

    // ── 4. Rol-koppeling (trigger vult klant_makelaar_toegang) ──
    await sbInsert('dossier_partijen', {
      dossier_id: dossier.id,
      klant_id:   klant.id,
      rol,
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        klant_id:           klant.id,
        dossier_id:         dossier.id,
        klant_hergebruikt:  klantHergebruikt,
      }),
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
