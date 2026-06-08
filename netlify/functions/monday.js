// netlify/functions/monday.js
// ─────────────────────────────────────────────────────────────────────────────
// HYBRIDE: Bezichtigingen-acties → Supabase, Bellijst-acties → Monday (legacy).
//
// Migratie status (6 mei 2026):
//   ✅ Naar Supabase:
//      - get_bezichtigingen
//      - get_gearchiveerde_bezichtigingen
//      - archiveer_bezichtiging
//      - markeer_afgehandeld
//      - push_naar_pool         (incl. Round Robin via toewijzingen-tabel)
//      - push_naar_eigen_bellijst   (zet alleen flag, kopie naar bellijst-board nog Monday)
//      - sla_feedback_op
//
//   ⏳ Nog op Monday (Groep 2 — Bellijst, latere migratie):
//      - get_leads, get_eigen_bellijst_board, update_lead_status
//      - assign_makelaar (oude RR via Make data-store), get_makelaars, get_alle_makelaars
//      - get_columns (debug)
//
// Backwards compatibility: alle response-shapes identiek aan oude versie zodat
// public/index.html ongewijzigd kan blijven.
// ─────────────────────────────────────────────────────────────────────────────

// ── MAPPING: Boards-label uit Meedoen Leadpool → bellijst-board-ID ────
const BELLIJST_LABELS = {
  'Bellijst_Ton':       '5095598157',
  'Bellijst_Mathias':   '5093235114',
  'Bellijst_Maurits':   '5093529769',
  'Bellijst_MauritsvL': '5095568381',
  'Bellijst_Rogier':    '5095567991',
  'Bellijst_Jori':      '5095568083',
  'Bellijst_Anthonie':  '5095568346',
  'Bellijst_Wilma':     '5095568404',
  'Bellijst_Pelle':     '5095568419',
  'Bellijst_Jan-Jaap':  '5095568639',
};

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const MVA_KANTOOR_ID       = 1; // MVA Amsterdam — vast voor nu, multi-tenant later

const sbHeaders = {
  apikey:        SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type':'application/json',
};

// ── SUPABASE HELPERS ──────────────────────────────────────────────────
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

const sbInsert = async (path, body) => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: { ...sbHeaders, Prefer: 'return=representation' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase POST ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
};

const sbDelete = async (path) => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'DELETE',
    headers: { ...sbHeaders, Prefer: 'return=representation' },
  });
  if (!res.ok) throw new Error(`Supabase DELETE ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
};

// ── RESEND MAIL HELPER ────────────────────────────────────────────────
// Stuurt notificatie-mail vanuit contact@makelaarsvan.nl. Faalt stilletjes —
// een mail-fout mag de lead-toewijzing nooit blokkeren. Gebruikt in
// push_naar_pool om de ontvangende makelaar te notificeren.
//
// Vereist Netlify env var: RESEND_API_KEY
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const MAIL_FROM = 'MVA Leadpool <contact@makelaarsvan.nl>';

const stuurMail = async ({ to, cc, subject, html }) => {
  if (!RESEND_API_KEY) {
    console.warn('[mail] RESEND_API_KEY ontbreekt — mail niet verstuurd');
    return { ok: false, reason: 'no_api_key' };
  }
  try {
    const payload = { from: MAIL_FROM, to, subject, html };
    if (cc && (Array.isArray(cc) ? cc.length : cc)) payload.cc = cc;
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const txt = await res.text();
      console.error(`[mail] Resend ${res.status}: ${txt}`);
      return { ok: false, reason: `http_${res.status}`, detail: txt };
    }
    const json = await res.json();
    console.log(`[mail] verstuurd naar ${to} (id=${json.id})`);
    return { ok: true, id: json.id };
  } catch (err) {
    console.error('[mail] uitzondering:', err.message);
    return { ok: false, reason: 'exception', detail: err.message };
  }
};

// Bouwt de HTML-body voor een lead-toewijzing-notificatie.
const renderLeadNotificatieMail = ({
  ontvangerNaam, klantNaam, adres, telefoon, email,
  gevendeMakelaar, opmerking, leadpoolUrl,
}) => {
  const esc = s => String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
  const veiligeTel = esc(telefoon || '—');
  const veiligEmail = esc(email || '—');
  const opmerkingBlok = opmerking
    ? `<tr><td style="padding:8px 0;color:#64748b;font-size:13px;width:140px">Opmerking</td>
         <td style="padding:8px 0;color:#1A2B5F;font-size:14px;font-style:italic">${esc(opmerking)}</td></tr>`
    : '';
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f4f6fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f4f6fa;padding:24px 0">
    <tr><td align="center">
      <table cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden">
        <tr><td style="background:#1A2B5F;padding:20px 24px;color:white">
          <div style="font-size:12px;letter-spacing:0.05em;opacity:0.8;text-transform:uppercase">MVA Leadpool</div>
          <div style="font-size:20px;font-weight:700;margin-top:4px">Nieuwe lead voor jou</div>
        </td></tr>
        <tr><td style="padding:24px">
          <div style="font-size:15px;color:#1A2B5F;margin-bottom:18px">
            Hoi ${esc(ontvangerNaam)}, je hebt een nieuwe lead ontvangen uit de pool.
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
          <div style="margin-top:24px;text-align:center">
            <a href="${leadpoolUrl}" style="display:inline-block;background:#E8500A;color:white;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;font-size:14px">
              Open in Leadpool →
            </a>
          </div>
          <div style="margin-top:24px;padding-top:16px;border-top:1px solid #e2e8f0;font-size:12px;color:#94a3b8;text-align:center">
            Wil je geen leads meer ontvangen? Zet Round Robin uit in de Leadpool-app.
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
};

// Bouwt de HTML-body voor een ALERT bij een persoonlijk doorgegeven lead.
// Urgenter dan de gewone pool-mail: de gever heeft de persoon zelf gesproken
// (bv. tijdens een bezichtiging) en geeft 'm gericht door — bel direct.
const renderHotLeadAlertMail = ({
  ontvangerNaam, klantNaam, adres, telefoon, email,
  gevendeMakelaar, opmerking, leadpoolUrl,
}) => {
  const esc = s => String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
  const veiligeTel = esc(telefoon || '—');
  const veiligEmail = esc(email || '—');
  const telKnop = telefoon
    ? `<a href="tel:${veiligeTel}" style="display:inline-block;background:#E8500A;color:white;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:700;font-size:15px">📞 Bel ${esc(klantNaam)} direct</a>`
    : '';
  const opmerkingBlok = opmerking
    ? `<tr><td style="padding:8px 0;color:#64748b;font-size:13px;width:150px;vertical-align:top">Notitie ${esc(gevendeMakelaar)}</td>
         <td style="padding:8px 0;color:#1A2B5F;font-size:14px;font-style:italic">${esc(opmerking)}</td></tr>`
    : '';
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f4f6fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f4f6fa;padding:24px 0">
    <tr><td align="center">
      <table cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;border:2px solid #E8500A">
        <tr><td style="background:#E8500A;padding:20px 24px;color:white">
          <div style="font-size:12px;letter-spacing:0.05em;opacity:0.9;text-transform:uppercase">MVA Leadpool · Persoonlijk doorgegeven</div>
          <div style="font-size:21px;font-weight:800;margin-top:4px">🔥 Bel deze lead direct</div>
        </td></tr>
        <tr><td style="padding:24px">
          <div style="font-size:15px;color:#1A2B5F;margin-bottom:18px">
            Hoi ${esc(ontvangerNaam)}, <strong>${esc(gevendeMakelaar)}</strong> heeft zojuist met deze persoon gesproken en geeft de lead gericht aan jou door. Bel zo snel mogelijk.
          </div>
          <table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse">
            <tr><td style="padding:8px 0;color:#64748b;font-size:13px;width:150px">Klant</td>
                <td style="padding:8px 0;color:#1A2B5F;font-size:15px;font-weight:600">${esc(klantNaam)}</td></tr>
            <tr><td style="padding:8px 0;color:#64748b;font-size:13px">Telefoon</td>
                <td style="padding:8px 0;color:#1A2B5F;font-size:14px"><a href="tel:${veiligeTel}" style="color:#E8500A;text-decoration:none;font-weight:600">${veiligeTel}</a></td></tr>
            <tr><td style="padding:8px 0;color:#64748b;font-size:13px">Email</td>
                <td style="padding:8px 0;color:#1A2B5F;font-size:14px"><a href="mailto:${veiligEmail}" style="color:#E8500A;text-decoration:none">${veiligEmail}</a></td></tr>
            <tr><td style="padding:8px 0;color:#64748b;font-size:13px">Adres bezichtiging</td>
                <td style="padding:8px 0;color:#1A2B5F;font-size:14px">${esc(adres)}</td></tr>
            ${opmerkingBlok}
          </table>
          <div style="margin-top:24px;text-align:center">
            ${telKnop}
          </div>
          <div style="margin-top:14px;text-align:center">
            <a href="${leadpoolUrl}" style="display:inline-block;color:#E8500A;text-decoration:none;font-weight:600;font-size:13px">Open in Leadpool →</a>
          </div>
          <div style="margin-top:24px;padding-top:16px;border-top:1px solid #e2e8f0;font-size:12px;color:#94a3b8;text-align:center">
            Na je gesprek: zet de lead in de juiste status in de Leadpool-app.
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
};

// ── HYPOTHEEK-DOORVERWIJZING: vaste ontvangers + mail-template ─────────
const HYPOTHEEK_ONTVANGERS = ['amsterdam547@hypotheekshop.nl', 'e.bitter@hypotheekshop.nl'];
const HYPOTHEEK_CC          = ['toncoffeng@makelaarsvan.nl'];

// Bouwt de HTML-body voor een doorverwijzing naar de Hypotheekshop.
const renderHypotheekMail = ({
  klantNaam, klantEmail, klantTelefoon,
  voorkeurAdviseur, typeAdvies, opmerking,
  gevendeMakelaar, adres,
}) => {
  const esc = s => String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
  const veiligeTel = esc(klantTelefoon || '—');
  const veiligEmail = esc(klantEmail || '—');
  const rij = (label, waarde) => waarde
    ? `<tr><td style="padding:8px 0;color:#64748b;font-size:13px;width:160px;vertical-align:top">${label}</td>
         <td style="padding:8px 0;color:#1A2B5F;font-size:14px">${waarde}</td></tr>`
    : '';
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f4f6fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f4f6fa;padding:24px 0">
    <tr><td align="center">
      <table cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden">
        <tr><td style="background:#1A2B5F;padding:20px 24px;color:white">
          <div style="font-size:12px;letter-spacing:0.05em;opacity:0.8;text-transform:uppercase">Makelaars van Amsterdam</div>
          <div style="font-size:20px;font-weight:700;margin-top:4px">Hypotheekdoorverwijzing</div>
        </td></tr>
        <tr><td style="padding:24px">
          <div style="font-size:15px;color:#1A2B5F;margin-bottom:18px">
            Beste collega's van de Hypotheekshop,<br><br>
            Hierbij een nieuwe klant die graag advies wil. De gegevens:
          </div>
          <table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse">
            <tr><td style="padding:8px 0;color:#64748b;font-size:13px;width:160px">Klant</td>
                <td style="padding:8px 0;color:#1A2B5F;font-size:15px;font-weight:600">${esc(klantNaam)}</td></tr>
            <tr><td style="padding:8px 0;color:#64748b;font-size:13px">Telefoon</td>
                <td style="padding:8px 0;color:#1A2B5F;font-size:14px"><a href="tel:${veiligeTel}" style="color:#E8500A;text-decoration:none">${veiligeTel}</a></td></tr>
            <tr><td style="padding:8px 0;color:#64748b;font-size:13px">E-mail</td>
                <td style="padding:8px 0;color:#1A2B5F;font-size:14px"><a href="mailto:${veiligEmail}" style="color:#E8500A;text-decoration:none">${veiligEmail}</a></td></tr>
            ${rij('Voorkeur adviseur', esc(voorkeurAdviseur))}
            ${rij('Welk advies', esc(typeAdvies))}
            ${rij('Gerelateerd pand', esc(adres))}
            ${rij('Toelichting', esc(opmerking))}
            ${rij('Doorgegeven door', esc(gevendeMakelaar))}
          </table>
          <div style="margin-top:24px;padding-top:16px;border-top:1px solid #e2e8f0;font-size:12px;color:#94a3b8">
            Deze doorverwijzing is verstuurd vanuit de MVA Leadpool. Reageer gerust rechtstreeks naar de doorgevende makelaar of de klant.
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
};

// ── TRANSFORMATIE: Supabase row → Monday-stijl object voor frontend ───
// De frontend (index.html) verwacht exact deze veldnamen — niet aanraken.
const rowToMondayShape = (b, makelaarNaam = '') => {
  // datum_tijd splitsen in 'datum' (YYYY-MM-DD) en 'tijdstip' (HH:MM Europe/Amsterdam)
  let datum = '', tijdstip = null;
  if (b.datum_tijd) {
    try {
      const d = new Date(b.datum_tijd);
      // Datum in lokale (Amsterdam) zone
      const dParts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Amsterdam',
        year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(d);
      datum = `${dParts.find(p=>p.type==='year').value}-${dParts.find(p=>p.type==='month').value}-${dParts.find(p=>p.type==='day').value}`;
      // Tijd HH:MM
      tijdstip = d.toLocaleTimeString('nl-NL', {
        timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit',
      });
    } catch { /* fallback: laat datum/tijdstip leeg */ }
  }

  // feedback_keys is een PG ARRAY → joinen tot CSV voor backwards compat
  const feedbackCsv = Array.isArray(b.feedback_keys) ? b.feedback_keys.join(',') : '';

  // Afleiden van legacy booleans uit actie_status
  const actie  = (b.actie_status || '').toLowerCase();
  const inPool = (actie === 'pool');
  const niet_naar_pool = (actie === 'zelf' || actie === 'afgehandeld');
  const doorgegeven    = (actie === 'pool');

  return {
    id:             String(b.id),
    naam:           b.bezichtiger_naam || '',
    adres:          b.adres || '',
    makelaar:       makelaarNaam,
    datum,
    tijdstip,
    telefoon:       b.bezichtiger_telefoon || '',
    email:          b.bezichtiger_email || '',
    niet_naar_pool,
    doorgegeven,
    in_pool:        inPool,
    gearchiveerd:   !!b.gearchiveerd,
    feedback:       feedbackCsv,
    opmerking:      b.feedback_opmerking || '',
    actie_status:   b.actie_status || '',
    type:           b.type || 'ingepland',
    publieke_token: b.publieke_token || null,
    open_huis_door_id: b.open_huis_door_id || null,
  };
};

const isMVAMakelaar = (naam) => {
  const n = (naam || '').toLowerCase();
  if (n.includes('filipe') || n.includes('bataglia')) return false;
  if (n.includes('gert-jan') || n.includes('gertjan') || n.includes('gert jan')) return false;
  return true;
};

// ── BELLIJST: maak een nieuw bellijst-item op basis van een bezichtiging ──
// Snapshot van bezichtiger-info wordt bevroren in het bellijst-item zodat
// het stabiel blijft tegen latere mutaties van de bezichtiging.
const createBellijstItem = async (bezichtiging, eigenaarId, bron) => {
  return await sbInsert('bellijst_items', {
    kantoor_id:           bezichtiging.kantoor_id || MVA_KANTOOR_ID,
    bezichtiging_id:      bezichtiging.id,
    eigenaar_id:          eigenaarId,
    bron:                 bron, // 'zelf' of 'pool'
    bezichtiger_naam:     bezichtiging.bezichtiger_naam,
    bezichtiger_email:    bezichtiging.bezichtiger_email,
    bezichtiger_telefoon: bezichtiging.bezichtiger_telefoon,
    adres:                bezichtiging.adres,
    datum_tijd:           bezichtiging.datum_tijd,
    gever_opmerking:      bezichtiging.feedback_opmerking || null,
    bel_status:           'nieuw',
    belpogingen:          0,
  });
};

// ── BEZICHTIGING: archiveer + zet actie_status tegelijk in 1 PATCH ────
// Gebruikt voor markeer_afgehandeld, push_naar_pool, push_naar_eigen_bellijst
// zodat een lead na uitgaan uit de gevende lijst altijd terugvindbaar is.
const archiveerBezichtiging = async (id, actieStatus) => {
  return await sbPatch(`bezichtigingen?id=eq.${id}`, {
    actie_status:        actieStatus, // 'pool' | 'zelf' | 'afgehandeld'
    gearchiveerd:        true,
    status_gewijzigd_op: new Date().toISOString(),
  });
};

// ── ROUND ROBIN: kies de volgende makelaar uit pool ───────────────────
// Strategie:
//   1. Selecteer alle gebruikers die meedoen aan RR + actief + niet op vakantie + niet de gever
//   2. Sorteer op volgnummer_laatste_toewijzing ASC, dan id ASC (deterministisch)
//   3. Pak nummer 1 → die is langst niet aan de beurt geweest
//   4. Update zijn volgnummer naar (max + 1)
//   5. Schrijf record in toewijzingen tabel als audit trail (status='open')
const roundRobinPick = async (bezichtigingId, gevendeMakelaarId) => {
  // 1. Pool ophalen — alle gebruikers met doet_mee_round_robin=true en actief=true
  // Vakantie-filter doen we lokaal (datum-vergelijking is leesbaarder dan PostgREST or-clauses)
  const pool = await sbGet(
    `gebruikers?select=id,naam,email,volgnummer_laatste_toewijzing,vakantie_van,vakantie_tot` +
    `&doet_mee_round_robin=eq.true&actief=eq.true&kantoor_id=eq.${MVA_KANTOOR_ID}` +
    `&order=volgnummer_laatste_toewijzing.asc.nullsfirst,id.asc`
  );

  // Filter: niet de gever, en niet op vakantie vandaag
  const vandaag = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const opVakantie = (g) => {
    if (!g.vakantie_van || !g.vakantie_tot) return false;
    return g.vakantie_van <= vandaag && vandaag <= g.vakantie_tot;
  };

  const candidates = pool.filter(g =>
    g.id !== gevendeMakelaarId && !opVakantie(g)
  );

  if (candidates.length === 0) {
    throw new Error(
      `Geen kandidaten beschikbaar in Round Robin pool ` +
      `(pool=${pool.length}, op_vakantie=${pool.filter(opVakantie).length}, gever=${gevendeMakelaarId})`
    );
  }

  // 2. Eerste kandidaat = volgnummer laagst → wint
  const gekozen = candidates[0];

  // 3. Nieuw volgnummer = max + 1 (over hele pool incl. gever, voor mooi oplopend)
  const huidigMax = pool.reduce((m, g) =>
    Math.max(m, g.volgnummer_laatste_toewijzing || 0), 0);
  const nieuwVolgnummer = huidigMax + 1;

  // 4. Update gekozen makelaar
  await sbPatch(`gebruikers?id=eq.${gekozen.id}`, {
    volgnummer_laatste_toewijzing: nieuwVolgnummer,
  });

  // 5. Audit trail in toewijzingen (status='open' = wachtend op acceptatie)
  await sbInsert('toewijzingen', {
    kantoor_id:       MVA_KANTOOR_ID,
    bezichtiging_id:  bezichtigingId,
    gebruiker_id:     gekozen.id,
    toegewezen_op:    new Date().toISOString(),
    status:           'open',
  });

  return {
    gekozen_id:       gekozen.id,
    gekozen_naam:     gekozen.naam,
    gekozen_email:    gekozen.email,
    nieuw_volgnummer: nieuwVolgnummer,
    pool_grootte:     candidates.length,
    op_vakantie:      pool.filter(opVakantie).map(g => g.naam),
  };
};

// ─────────────────────────────────────────────────────────────────────
// EXTERN PICK — voor extern-gevers (Filipe, Gert-Jan) gaat de lead NIET
// via de RR-pool maar direct naar de andere actieve extern-makelaar.
// Filipe geeft → Gert-Jan ontvangt, en vice versa.
//
// Edge case: als de andere extern-makelaar niet beschikbaar is (vakantie,
// RR uit, of niet actief) → throw error met duidelijke melding. De aanroep
// in push_naar_pool vangt deze op en zet de lead terug bij de gever.
// ─────────────────────────────────────────────────────────────────────
const externPick = async (bezichtigingId, gevendeMakelaarId) => {
  // Haal alle externs op behalve de gever, alleen actieve, doet_mee_round_robin=true
  // (toggle in app), niet op vakantie.
  const externs = await sbGet(
    `gebruikers?select=id,naam,email,vakantie_van,vakantie_tot` +
    `&rol=eq.extern&actief=eq.true&doet_mee_round_robin=eq.true` +
    `&kantoor_id=eq.${MVA_KANTOOR_ID}` +
    `&id=neq.${gevendeMakelaarId}`
  );

  const vandaag = new Date().toISOString().split('T')[0];
  const opVakantie = (g) =>
    g.vakantie_van && g.vakantie_tot &&
    g.vakantie_van <= vandaag && vandaag <= g.vakantie_tot;

  const kandidaten = externs.filter(g => !opVakantie(g));

  if (kandidaten.length === 0) {
    throw new Error(
      `EXTERN_GEEN_KANDIDAAT: geen actieve extern-makelaar beschikbaar ` +
      `(externs gevonden=${externs.length}, allen op vakantie of niet actief)`
    );
  }

  // Bij meer dan 1 (toekomstig?): kies degene met laagste volgnummer.
  // Voor nu: eerste = enige.
  const gekozen = kandidaten[0];

  await sbInsert('toewijzingen', {
    kantoor_id:       MVA_KANTOOR_ID,
    bezichtiging_id:  bezichtigingId,
    gebruiker_id:     gekozen.id,
    toegewezen_op:    new Date().toISOString(),
    status:           'open',
  });

  return {
    gekozen_id:    gekozen.id,
    gekozen_naam:  gekozen.naam,
    gekozen_email: gekozen.email,
    pool_grootte:  kandidaten.length,
    via_extern:    true,
  };
};

// ─────────────────────────────────────────────────────────────────────
// HANDLER
// ─────────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type':                 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const { action, data } = JSON.parse(event.body || '{}');

  try {
    // ═════════════════════════════════════════════════════════════════
    // GROEP 1 — BEZICHTIGINGEN-ACTIES (Supabase)
    // ═════════════════════════════════════════════════════════════════

    // ── BEZICHTIGINGEN OPHALEN (alle open, voor gevende makelaar) ────
    if (action === 'get_bezichtigingen') {
      const { makelaar_naam, makelaar_email } = data;

      // Lookup gebruiker_id via email (voorkeur) of naam
      let makelaarId = null, makelaarNaam = makelaar_naam || '';
      if (makelaar_email) {
        const u = await sbGet(`gebruikers?select=id,naam&email=eq.${encodeURIComponent(makelaar_email.toLowerCase())}`);
        if (u[0]) { makelaarId = u[0].id; makelaarNaam = u[0].naam; }
      }
      if (!makelaarId && makelaar_naam) {
        const u = await sbGet(`gebruikers?select=id,naam&naam=eq.${encodeURIComponent(makelaar_naam)}`);
        if (u[0]) { makelaarId = u[0].id; makelaarNaam = u[0].naam; }
      }
      if (!makelaarId) {
        return { statusCode: 200, headers, body: JSON.stringify({ bezichtigingen: [], info: 'gebruiker niet gevonden' }) };
      }

      // Alle niet-gearchiveerde bezichtigingen voor deze gever
      const rows = await sbGet(
        `bezichtigingen?select=*&gevende_makelaar_id=eq.${makelaarId}` +
        `&gearchiveerd=eq.false&order=datum_tijd.desc&limit=500`
      );

      // Filter lege placeholder-slots eruit (Realworks Bezichtigingsplanner
      // levert ook lege "+ Relatie koppelen" tijdslots door — geen naam, geen
      // email, geen telefoon. Niets om feedback over te geven, dus verbergen.)
      const isLegeSlot = (b) =>
        !((b.bezichtiger_naam || '').trim()) &&
        !((b.bezichtiger_email || '').trim()) &&
        !((b.bezichtiger_telefoon || '').trim());

      const bezichtigingen = rows
        .filter(r => !isLegeSlot(r))
        .map(r => {
          const shape = rowToMondayShape(r, makelaarNaam);
          // Voor open-huis-bezoeker-kaarten: doorsturen mag alleen als de
          // ingelogde (verkopend) makelaar het open huis ZELF draaide.
          // Ander draaide → kaart is ter info, geen doorstuur-acties.
          if (shape.type === 'open_huis_bezoeker') {
            shape.mag_doorsturen = (r.open_huis_door_id === makelaarId);
          } else {
            shape.mag_doorsturen = true; // gewone bezichtigingen: altijd
          }
          return shape;
        })
        .filter(b => isMVAMakelaar(b.makelaar));

      return { statusCode: 200, headers, body: JSON.stringify({ bezichtigingen }) };
    }

    // ── PANDEN OPHALEN VOOR DROPDOWN (open huis) ─────────────────────
    // Geeft beschikbare panden terug: eigen panden eerst, daarna de rest.
    // De ingelogde makelaar wordt opgezocht via email zodat we 'eigen' kunnen
    // markeren. Een trainee ziet zo zijn eigen (lege) lijst bovenaan en kan
    // daaronder het pand van bijv. Rogier kiezen.
    if (action === 'get_panden_voor_makelaar') {
      const { makelaar_email, makelaar_naam } = data;

      let makelaarId = null;
      if (makelaar_email) {
        const u = await sbGet(`gebruikers?select=id&email=eq.${encodeURIComponent(makelaar_email.toLowerCase())}`);
        if (u[0]) makelaarId = u[0].id;
      }
      if (!makelaarId && makelaar_naam) {
        const u = await sbGet(`gebruikers?select=id&naam=eq.${encodeURIComponent(makelaar_naam)}`);
        if (u[0]) makelaarId = u[0].id;
      }

      // Alle beschikbare panden ophalen
      const panden = await sbGet(
        `panden?select=id,adres,plaats,postcode,status,eigenaar_id&status=eq.BESCHIKBAAR&order=adres.asc`
      );

      // Eigenaarsnamen erbij voor weergave
      const eigenaarIds = [...new Set(panden.map(p => p.eigenaar_id).filter(Boolean))];
      let namen = {};
      if (eigenaarIds.length) {
        const gs = await sbGet(`gebruikers?select=id,naam&id=in.(${eigenaarIds.join(',')})`);
        gs.forEach(g => { namen[g.id] = g.naam; });
      }

      // Verrijken + splitsen in eigen / overig
      const verrijkt = panden.map(p => ({
        id:            p.id,
        adres:         p.adres,
        plaats:        p.plaats || '',
        postcode:      p.postcode || '',
        eigenaar_id:   p.eigenaar_id,
        eigenaar_naam: namen[p.eigenaar_id] || '',
        is_eigen:      makelaarId && p.eigenaar_id === makelaarId,
      }));

      const eigen  = verrijkt.filter(p => p.is_eigen);
      const overig = verrijkt.filter(p => !p.is_eigen);

      return {
        statusCode: 200, headers,
        body: JSON.stringify({ ok: true, eigen, overig }),
      };
    }

    // ── OPEN HUIS AANMAKEN ───────────────────────────────────────────
    // Maakt een bezichtiging met type='open_huis'. Géén bezichtiger-gegevens
    // (die komen later binnen via QR-inschrijvingen).
    //
    // Twee scenario's:
    //  1. Pand gekozen uit dropdown (pand_id meegegeven): de inschrijving gaat
    //     naar de VERKOPEND makelaar (eigenaar van het pand). De ingelogde
    //     makelaar wordt vastgelegd als open_huis_door_id (kan een trainee zijn).
    //  2. Handmatig adres (geen pand_id): valt terug op de ingelogde makelaar
    //     als gevende makelaar, want we weten niet wie de verkopend makelaar is.
    if (action === 'maak_open_huis') {
      const { makelaar_email, makelaar_naam, adres, datum_tijd, pand_id } = data;

      // Lookup ingelogde makelaar
      let ingelogdeId = null;
      if (makelaar_email) {
        const u = await sbGet(`gebruikers?select=id,naam&email=eq.${encodeURIComponent(makelaar_email.toLowerCase())}`);
        if (u[0]) ingelogdeId = u[0].id;
      }
      if (!ingelogdeId && makelaar_naam) {
        const u = await sbGet(`gebruikers?select=id,naam&naam=eq.${encodeURIComponent(makelaar_naam)}`);
        if (u[0]) ingelogdeId = u[0].id;
      }
      if (!ingelogdeId) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Makelaar niet gevonden' }) };
      }

      // Bepaal adres + verkopend makelaar
      let definitiefAdres = (adres || '').trim();
      let verkopendId = ingelogdeId; // default: handmatig → ingelogde makelaar
      let gekoppeldPandId = null;

      if (pand_id) {
        // Pand uit dropdown: haal adres + eigenaar uit panden-tabel (betrouwbaar)
        const prows = await sbGet(`panden?select=id,adres,plaats,postcode,eigenaar_id&id=eq.${pand_id}`);
        if (!prows[0]) {
          return { statusCode: 404, headers, body: JSON.stringify({ error: 'Pand niet gevonden' }) };
        }
        const pand = prows[0];
        gekoppeldPandId = pand.id;
        definitiefAdres = [pand.adres, pand.postcode, pand.plaats].filter(Boolean).join(', ');
        if (pand.eigenaar_id) verkopendId = pand.eigenaar_id;
      }

      if (!definitiefAdres) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Adres is verplicht' }) };
      }

      // Token genereren
      const token = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : require('crypto').randomUUID();

      let created;
      try {
        created = await sbInsert('bezichtigingen', {
          kantoor_id:          MVA_KANTOOR_ID,
          gevende_makelaar_id: verkopendId,        // inschrijving gaat hierheen
          open_huis_door_id:   ingelogdeId,        // wie het open huis draait
          pand_id:             gekoppeldPandId,
          adres:               definitiefAdres,
          datum_tijd:          datum_tijd || null,
          type:                'open_huis',
          publieke_token:      token,
          actie_status:        'open',
          gearchiveerd:        false,
        });
      } catch (e) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: `Open huis aanmaken faalde: ${e.message}` }) };
      }

      const bez = created[0];
      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          ok:             true,
          id:             String(bez.id),
          publieke_token: bez.publieke_token,
          adres:          bez.adres,
          datum_tijd:     bez.datum_tijd,
        }),
      };
    }

    // ── GEARCHIVEERDE BEZICHTIGINGEN OPHALEN ─────────────────────────
    if (action === 'get_gearchiveerde_bezichtigingen') {
      const { makelaar_naam, makelaar_email } = data;

      let makelaarId = null, makelaarNaam = makelaar_naam || '';
      if (makelaar_email) {
        const u = await sbGet(`gebruikers?select=id,naam&email=eq.${encodeURIComponent(makelaar_email.toLowerCase())}`);
        if (u[0]) { makelaarId = u[0].id; makelaarNaam = u[0].naam; }
      }
      if (!makelaarId && makelaar_naam) {
        const u = await sbGet(`gebruikers?select=id,naam&naam=eq.${encodeURIComponent(makelaar_naam)}`);
        if (u[0]) { makelaarId = u[0].id; makelaarNaam = u[0].naam; }
      }
      if (!makelaarId) {
        return { statusCode: 200, headers, body: JSON.stringify({ bezichtigingen: [] }) };
      }

      const rows = await sbGet(
        `bezichtigingen?select=*&gevende_makelaar_id=eq.${makelaarId}` +
        `&gearchiveerd=eq.true&order=datum_tijd.desc&limit=500`
      );

      // Doorgegeven leads worden weliswaar gearchiveerd (gearchiveerd=true) om uit de
      // open-feedbacklijst te verdwijnen, maar horen NIET thuis in het Archief:
      //   - actie_status 'pool' → vindbaar in de Doorgegeven-weergave
      //   - actie_status 'zelf' → vindbaar in de eigen bellijst / Leads-tab
      // Alleen écht afgehandelde ('afgehandeld') en oude/automatisch gearchiveerde
      // bezichtigingen (actie_status leeg/null) blijven hier zichtbaar.
      // Null-veilig: r.actie_status !== 'pool' is true bij null/'' → blijft zichtbaar.
      const zichtbaar = rows.filter(r => r.actie_status !== 'pool' && r.actie_status !== 'zelf');

      const bezichtigingen = zichtbaar.map(r => rowToMondayShape(r, makelaarNaam));
      return { statusCode: 200, headers, body: JSON.stringify({ bezichtigingen }) };
    }

    // ── ARCHIVEREN ───────────────────────────────────────────────────
    if (action === 'archiveer_bezichtiging') {
      const { item_id, archiveer } = data;
      const naarArchief = archiveer !== false;

      // Houd actie_status consistent met de archiefstatus. Voorheen zette deze
      // actie alleen `gearchiveerd` en liet actie_status ongemoeid; daardoor kon
      // een open(-huis) bezichtiging (actie_status 'open') of open-feedback (leeg)
      // gearchiveerd raken terwijl de status 'open'/leeg bleef → de lead verdween
      // uit de actieve lijst én dook als 'spook' op in het archief.
      //   • archiveren  → 'afgehandeld'  (bewust uit de werklijst, hoort in Archief)
      //   • herstellen  → ''             (terug als open feedback in de actieve lijst)
      // Het open-huis-karakter blijft behouden: dat zit in de kolom `type`
      // ('open_huis'), niet in actie_status. Pool/zelf-leads lopen via een eigen
      // flow (helper archiveerBezichtiging) en komen hier in de praktijk niet langs.
      const updated = await sbPatch(`bezichtigingen?id=eq.${item_id}`, {
        gearchiveerd:        naarArchief,
        actie_status:        naarArchief ? 'afgehandeld' : '',
        status_gewijzigd_op: new Date().toISOString(),
      });

      return {
        statusCode: 200, headers,
        body: JSON.stringify({ ok: true, gearchiveerd: naarArchief, item_id, updated_count: updated.length }),
      };
    }

    // ── MARKEER AFGEHANDELD ──────────────────────────────────────────
    // Lead is afgehandeld zonder dat hij naar bellijst of pool gaat.
    // (bv. al klant elders, no-show, irrelevant). Gaat direct naar archief.
    if (action === 'markeer_afgehandeld') {
      const { item_id } = data;
      const updated = await archiveerBezichtiging(item_id, 'afgehandeld');
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, item_id, updated_count: updated.length }) };
    }

    // ── PUSH NAAR POOL (Round Robin) ─────────────────────────────────
    // Lead naar de leadpool: Round Robin kiest ontvanger, bezichtiging
    // gaat naar archief, en er wordt een bellijst_item aangemaakt voor
    // de ontvanger met bron='pool'.
    //
    // Optioneel: data.direct_naar_email = '<email>' bypassed Round Robin
    // en wijst de lead direct toe aan die makelaar. Wordt gebruikt door
    // de "slimme routing" flow: als de bezichtiger al in Cloze bekend is
    // bij makelaar X, gaat de lead direct naar X (niet via RR).
    if (action === 'push_naar_pool') {
      const { item_id, direct_naar_email } = data;

      // Lees volledige bezichtiging (nodig voor snapshot in bellijst_item)
      const bezRows = await sbGet(`bezichtigingen?select=*&id=eq.${item_id}`);
      if (!bezRows[0]) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: `Bezichtiging ${item_id} niet gevonden` }) };
      }
      const bez = bezRows[0];

      // Bepaal ontvanger: direct toewijzen of via Round Robin
      let rr;
      const useDirectAssign = !!direct_naar_email;

      if (useDirectAssign) {
        // ── Direct toewijzen aan opgegeven email (bypass RR) ─────────
        const targetEmail = String(direct_naar_email).toLowerCase().trim();
        const userRows = await sbGet(
          `gebruikers?email=eq.${encodeURIComponent(targetEmail)}` +
          `&actief=eq.true&select=id,naam,email,kantoor_id`
        );
        if (!userRows[0]) {
          return {
            statusCode: 400, headers,
            body: JSON.stringify({
              error: `Direct-toewijzing faalde: gebruiker ${targetEmail} niet gevonden of inactief`
            }),
          };
        }
        const target = userRows[0];

        // Audit trail: zelfde structuur als roundRobinPick gebruikt, zodat
        // toewijzingen-tabel consistent blijft. status='open' = wachtend op
        // acceptatie. We loggen geen 'aanleiding' in de DB (kolom bestaat
        // niet) — onderscheid met RR zit in de bron='cloze_direct' op
        // bellijst_items en in via_cloze_routing in de response.
        await sbInsert('toewijzingen', {
          kantoor_id:      MVA_KANTOOR_ID,
          bezichtiging_id: parseInt(item_id),
          gebruiker_id:    target.id,
          toegewezen_op:   new Date().toISOString(),
          status:          'open',
        });

        rr = {
          gekozen_id: target.id,
          gekozen_naam: target.naam,
          gekozen_email: target.email,
          pool_grootte: null,  // n.v.t. — was bypass
        };
      } else {
        // ── Check eerst of gever 'extern' is (Filipe/Gert-Jan flow) ──
        // Extern-gevers gaan NIET via de RR-pool. Lead gaat direct naar
        // de andere extern-makelaar. Bij geen kandidaat: lead blijft bij
        // de gever (er wordt niets aangemaakt en de bezichtiging blijft
        // open in zijn lijst).
        let externRouting = false;
        if (bez.gevende_makelaar_id) {
          try {
            const geverRows = await sbGet(
              `gebruikers?select=rol&id=eq.${bez.gevende_makelaar_id}`
            );
            if (geverRows[0]?.rol === 'extern') externRouting = true;
          } catch { /* fallback naar RR */ }
        }

        if (externRouting) {
          // ── Extern → andere extern (Filipe ↔ Gert-Jan) ─────────────
          try {
            rr = await externPick(parseInt(item_id), bez.gevende_makelaar_id);
          } catch (e) {
            // Geen kandidaat → lead blijft bij gever, geen bellijst-item
            console.warn(`[push_naar_pool] extern-routing faalde: ${e.message}`);
            return {
              statusCode: 200, headers,
              body: JSON.stringify({
                ok: false,
                reden: 'extern_geen_kandidaat',
                bericht: 'Je collega is niet beschikbaar. De lead blijft bij jou staan — je kunt m later opnieuw doorgeven of zelf bellen.',
              }),
            };
          }
        } else {
          // ── Standaard: Round Robin ──────────────────────────────────
          try {
            rr = await roundRobinPick(parseInt(item_id), bez.gevende_makelaar_id);
          } catch (e) {
            return { statusCode: 500, headers, body: JSON.stringify({ error: `Round Robin faalde: ${e.message}` }) };
          }
        }
      }

      // Maak bellijst_item voor de gekozen ontvanger (snapshot van bezichtiger)
      // Bron blijft 'pool' ook bij direct-assign — CHECK constraint accepteert
      // alleen 'zelf'/'pool'. Onderscheid Direct vs RR zit in toewijzingen-tabel
      // en in via_cloze_routing in de response.
      let bellijstItem;
      try {
        const created = await createBellijstItem(bez, rr.gekozen_id, 'pool');
        bellijstItem = created[0];
      } catch (e) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: `Bellijst-item aanmaken faalde: ${e.message}` }) };
      }

      // Archiveer bezichtiging (uit gevende lijst, in archief vindbaar)
      await archiveerBezichtiging(item_id, 'pool');

      // ── Notificatie-mail naar ontvangende makelaar ──────────────────
      // DIRECTE toewijzing (gever geeft tijdens/na een bezichtiging een lead
      // persoonlijk door aan een specifieke collega) → urgente ALERT-mail
      // "bel direct". Round Robin → de gewone "nieuwe lead"-mail.
      // Faalt stilletjes — een mail-fout mag de pool-flow nooit blokkeren.
      if (rr.gekozen_email) {
        // Naam gevende makelaar: betrouwbaar uit gebruikers, anders uit payload.
        let gevendeMakelaar = data.makelaar_naam || 'een collega';
        if (bez.gevende_makelaar_id) {
          try {
            const gRows = await sbGet(
              `gebruikers?select=naam&id=eq.${bez.gevende_makelaar_id}`
            );
            if (gRows[0]?.naam) gevendeMakelaar = gRows[0].naam;
          } catch { /* mag falen */ }
        }

        const mailData = {
          ontvangerNaam: rr.gekozen_naam,
          klantNaam:     bez.bezichtiger_naam || 'Onbekend',
          adres:         bez.adres || '—',
          telefoon:      bez.bezichtiger_telefoon || '',
          email:         bez.bezichtiger_email || '',
          gevendeMakelaar,
          opmerking:     bez.feedback_opmerking || '',
          leadpoolUrl:   'https://mvaleadpool.netlify.app/',
        };

        // Netlify Functions kunnen geen async werk ná de response doen, dus
        // awaiten we (stuurMail faalt stilletjes bij een fout).
        if (useDirectAssign) {
          await stuurMail({
            to:      rr.gekozen_email,
            subject: `🔥 ${gevendeMakelaar} geeft je een lead door — bel direct: ${bez.bezichtiger_naam || 'bezichtiger'}`.trim(),
            html:    renderHotLeadAlertMail(mailData),
          });
        } else {
          await stuurMail({
            to:      rr.gekozen_email,
            subject: `Nieuwe lead: ${bez.bezichtiger_naam || 'bezichtiger'} · ${bez.adres || ''}`.trim(),
            html:    renderLeadNotificatieMail(mailData),
          });
        }
      }

      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          ok: true,
          item_id,
          toegewezen_aan:    rr.gekozen_naam,
          email_toegewezen:  rr.gekozen_email,
          gekozen_id:        rr.gekozen_id,
          pool_grootte:      rr.pool_grootte,
          bellijst_item_id:  bellijstItem?.id,
          via_cloze_routing: useDirectAssign,  // true = bypass RR
        }),
      };
    }

    // ── HERSTEL UIT POOL (undo "door naar pool") ─────────────────────
    // Rogier-vraag: hij drukte per ongeluk "door naar pool". Deze action draait
    // push_naar_pool terug: de bezichtiging komt terug in zijn gevende lijst.
    //
    // VEILIGHEID: alleen toegestaan zolang de ontvanger nog NIETS met de lead
    // heeft gedaan (bel_status='nieuw' EN belpogingen=0). Heeft de ontvanger al
    // gebeld/een status gezet, dan blokkeren we — anders gooien we werk van een
    // collega weg. De mail die de ontvanger kreeg is al verstuurd; daarom geven
    // we 'm via e-mail een seintje dat de lead is teruggetrokken (faalt stil).
    if (action === 'herstel_uit_pool') {
      const { item_id } = data; // = bezichtiging-id

      // 1. Vind het bijbehorende bellijst_item (de pool-toewijzing)
      const items = await sbGet(
        `bellijst_items?select=*&bezichtiging_id=eq.${item_id}&bron=eq.pool&order=id.desc`
      );
      if (!items[0]) {
        // Niets in de pool gevonden → mogelijk al hersteld of nooit gepusht.
        // De-archiveer alsnog de bezichtiging zodat 'ie terugkomt in de lijst.
        await sbPatch(`bezichtigingen?id=eq.${item_id}`, {
          actie_status: '', gearchiveerd: false, status_gewijzigd_op: new Date().toISOString(),
        });
        return {
          statusCode: 200, headers,
          body: JSON.stringify({ ok: true, hersteld: true, info: 'geen pool-item gevonden, bezichtiging gede-archiveerd' }),
        };
      }
      const item = items[0];

      // 2. Veiligheidscheck: heeft de ontvanger de lead al opgepakt?
      const alOpgepakt = (item.bel_status && item.bel_status !== 'nieuw') || (item.belpogingen || 0) > 0;
      if (alOpgepakt) {
        // Naam ontvanger ophalen voor een nette melding
        let ontvangerNaam = 'de ontvangende makelaar';
        try {
          const u = await sbGet(`gebruikers?select=naam&id=eq.${item.eigenaar_id}`);
          if (u[0]?.naam) ontvangerNaam = u[0].naam;
        } catch { /* mag falen */ }
        return {
          statusCode: 200, headers,
          body: JSON.stringify({
            ok: false,
            reden: 'al_opgepakt',
            bericht: `Kan niet terughalen: ${ontvangerNaam} is al met deze lead aan de slag (status: ${item.bel_status}${item.belpogingen ? `, ${item.belpogingen} belpoging(en)` : ''}). Neem even contact op met je collega.`,
          }),
        };
      }

      // 3. Gegevens ontvanger ophalen (voor terugtrek-seintje) vóór we verwijderen
      let ontvanger = null;
      try {
        const u = await sbGet(`gebruikers?select=naam,email&id=eq.${item.eigenaar_id}`);
        if (u[0]) ontvanger = u[0];
      } catch { /* mag falen */ }

      // 4. Verwijder het bellijst_item (lead verdwijnt uit ontvangers bellijst)
      try {
        await sbDelete(`bellijst_items?id=eq.${item.id}`);
      } catch (e) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: `Bellijst-item verwijderen faalde: ${e.message}` }) };
      }

      // 5. Trek de toewijzing in (audit-trail: status='ingetrokken' i.p.v. delete,
      //    zodat de geschiedenis zichtbaar blijft). Alleen open toewijzingen.
      try {
        await sbPatch(
          `toewijzingen?bezichtiging_id=eq.${item_id}&status=eq.open`,
          { status: 'ingetrokken' }
        );
      } catch (e) {
        console.warn('[herstel_uit_pool] toewijzing intrekken faalde (niet kritiek):', e.message);
      }

      // 6. De-archiveer de bezichtiging → terug in de gevende lijst
      await sbPatch(`bezichtigingen?id=eq.${item_id}`, {
        actie_status: '', gearchiveerd: false, status_gewijzigd_op: new Date().toISOString(),
      });

      // 7. Seintje naar ontvanger dat de lead is teruggetrokken (faalt stil)
      if (ontvanger?.email) {
        try {
          await stuurMail({
            to: ontvanger.email,
            subject: `Lead teruggetrokken: ${item.bezichtiger_naam || 'bezichtiger'} · ${item.adres || ''}`.trim(),
            html: `<p>Hoi ${ontvanger.naam || ''},</p>
              <p>De lead <strong>${item.bezichtiger_naam || 'bezichtiger'}</strong>${item.adres ? ` (${item.adres})` : ''} is door de gevende makelaar teruggetrokken uit de pool — die houdt 'm zelf. Je hoeft hier niets mee te doen; de lead is uit je bellijst verdwenen.</p>
              <p>— MVA Leadpool</p>`,
          });
        } catch (e) {
          console.warn('[herstel_uit_pool] terugtrek-mail faalde (niet kritiek):', e.message);
        }
      }

      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          ok: true,
          hersteld: true,
          item_id,
          ontvanger_genotificeerd: !!ontvanger?.email,
        }),
      };
    }

    // ── PUSH NAAR EIGEN BELLIJST (Zelf bellen) ───────────────────────
    // Lead naar eigen bellijst: bezichtiging gaat naar archief, bellijst_item
    // wordt aangemaakt voor de gevende makelaar zelf met bron='zelf'.
    if (action === 'push_naar_eigen_bellijst') {
      const { item_id } = data;

      // Lees volledige bezichtiging (nodig voor snapshot + gevende_makelaar_id)
      const bezRows = await sbGet(`bezichtigingen?select=*&id=eq.${item_id}`);
      if (!bezRows[0]) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: `Bezichtiging ${item_id} niet gevonden` }) };
      }
      const bez = bezRows[0];

      if (!bez.gevende_makelaar_id) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: `Bezichtiging ${item_id} heeft geen gevende_makelaar_id` }) };
      }

      // Maak bellijst_item voor de gever zelf
      let bellijstItem;
      try {
        const created = await createBellijstItem(bez, bez.gevende_makelaar_id, 'zelf');
        bellijstItem = created[0];
      } catch (e) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: `Bellijst-item aanmaken faalde: ${e.message}` }) };
      }

      // Archiveer bezichtiging
      await archiveerBezichtiging(item_id, 'zelf');

      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          ok: true,
          item_id,
          actie_status:     'zelf',
          eigenaar_id:      bez.gevende_makelaar_id,
          bellijst_item_id: bellijstItem?.id,
        }),
      };
    }

    // ── HERVERDEEL LEAD (ontvanger geeft door) ───────────────────────
    // Een makelaar die al een lead in zijn bellijst heeft, geeft 'm door.
    // Twee modi:
    //   - naar_email gezet  → direct aan die collega (dropdown-keuze)
    //   - naar_email leeg   → terug naar pool via Round Robin, waarbij de
    //                          huidige eigenaar zelf wordt uitgesloten.
    //
    // We VERPLAATSEN het bestaande bellijst_item (nieuwe eigenaar_id) zodat
    // de historie (notities, belpogingen) meereist. Status wordt teruggezet
    // naar 'nieuw' zodat de lead bovenaan en als open verschijnt bij de
    // nieuwe eigenaar. Herkomst komt in gever_opmerking te staan.
    if (action === 'herverdeel_lead') {
      const { bellijst_item_id, naar_email, doorgever_naam } = data || {};
      if (!bellijst_item_id) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'bellijst_item_id vereist' }) };
      }

      // 1. Huidige item lezen
      const itemRows = await sbGet(`bellijst_items?select=*&id=eq.${bellijst_item_id}`);
      if (!itemRows[0]) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: `Lead ${bellijst_item_id} niet gevonden` }) };
      }
      const item = itemRows[0];
      const huidigeEigenaarId = item.eigenaar_id;

      // 2. Doelmakelaar bepalen
      let target;          // { id, naam, email }
      let viaPool = false;

      if (naar_email) {
        // ── Dropdown: direct aan gekozen collega ───────────────────
        const targetEmail = String(naar_email).toLowerCase().trim();
        const userRows = await sbGet(
          `gebruikers?select=id,naam,email&email=eq.${encodeURIComponent(targetEmail)}` +
          `&actief=eq.true&kantoor_id=eq.${MVA_KANTOOR_ID}`
        );
        if (!userRows[0]) {
          return {
            statusCode: 400, headers,
            body: JSON.stringify({ error: `Doorgeven faalde: ${targetEmail} niet gevonden of inactief` }),
          };
        }
        if (userRows[0].id === huidigeEigenaarId) {
          return {
            statusCode: 400, headers,
            body: JSON.stringify({ error: 'Je kunt een lead niet aan jezelf doorgeven' }),
          };
        }
        target = userRows[0];
      } else {
        // ── Terug naar pool: Round Robin, huidige eigenaar uitgesloten ──
        let rr;
        try {
          // roundRobinPick sluit param 2 (gever) uit → huidige eigenaar
          rr = await roundRobinPick(item.bezichtiging_id || null, huidigeEigenaarId);
        } catch (e) {
          return {
            statusCode: 200, headers,
            body: JSON.stringify({ ok: false, reden: 'geen_kandidaat', error: e.message }),
          };
        }
        target = { id: rr.gekozen_id, naam: rr.gekozen_naam, email: rr.gekozen_email };
        viaPool = true;
      }

      // 3. Herkomst-notitie samenstellen (behoudt bestaande gever_opmerking)
      const vandaagNL = new Date().toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' });
      const herkomst = `Doorgegeven door ${doorgever_naam || 'collega'} op ${vandaagNL}`;
      const nieuweGeverOpmerking = item.gever_opmerking
        ? `${item.gever_opmerking}\n${herkomst}`
        : herkomst;

      // 4. Item VERPLAATSEN naar nieuwe eigenaar (historie reist mee)
      await sbPatch(`bellijst_items?id=eq.${bellijst_item_id}`, {
        eigenaar_id:     target.id,
        bron:            'pool',
        bel_status:      'nieuw',
        belpogingen:     0,
        gever_opmerking: nieuweGeverOpmerking,
        // herinneringen resetten zodat de nieuwe eigenaar weer genudged kan worden
        herinnering_1_verzonden_op: null,
        herinnering_2_verzonden_op: null,
        toegevoegd_op:   new Date().toISOString(),
      });

      // 5. Notificatie-mail naar de nieuwe eigenaar (faalt stilletjes)
      try {
        const html = renderLeadNotificatieMail({
          ontvangerNaam:   target.naam,
          klantNaam:       item.bezichtiger_naam || '(geen naam)',
          adres:           item.adres || '',
          telefoon:        item.bezichtiger_telefoon || '',
          email:           item.bezichtiger_email || '',
          gevendeMakelaar: doorgever_naam || 'een collega',
          opmerking:       item.opmerking || '',
          leadpoolUrl:     'https://mvaleadpool.netlify.app/',
        });
        await stuurMail({
          to:      target.email,
          subject: `Nieuwe lead voor jou: ${item.bezichtiger_naam || 'onbekend'}`,
          html,
        });
      } catch (e) {
        console.warn('[herverdeel_lead] mail faalde (niet kritiek):', e.message);
      }

      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          ok:            true,
          via_pool:      viaPool,
          nieuwe_eigenaar_naam:  target.naam,
          nieuwe_eigenaar_email: target.email,
        }),
      };
    }

    // ── HYPOTHEEK-DOORVERWIJZING ─────────────────────────────────────
    // Een makelaar (bezichtigingen- of bellijst-flow) verwijst een klant
    // door naar de Hypotheekshop. We registreren in de tabel
    // hypotheek_doorverwijzingen én sturen een notificatiemail naar de
    // Hypotheekshop (CC Ton + de doorgevende makelaar). Mail-fout blokkeert
    // de registratie niet — de doorverwijzing is dan wel vastgelegd.
    if (action === 'verwijs_hypotheek') {
      const {
        klant_naam, klant_email, klant_telefoon,
        voorkeur_adviseur, type_advies, opmerking,
        gevende_makelaar_id, gevende_makelaar_naam, gevende_makelaar_email,
        bellijst_item_id, bezichtiging_id, adres,
      } = data || {};

      if (!klant_naam && !klant_email && !klant_telefoon) {
        return {
          statusCode: 400, headers,
          body: JSON.stringify({ error: 'Minimaal naam, e-mail of telefoon van de klant vereist' }),
        };
      }

      // 1. Registreer in de tabel (status default 'aangevraagd')
      // De frontend stuurt geen makelaar-id mee (huidigeMakelaar kent alleen
      // email/naam) — zoek de id op via email zodat de FK gevuld wordt.
      let makelaarId = gevende_makelaar_id ? parseInt(gevende_makelaar_id) : null;
      if (!makelaarId && gevende_makelaar_email) {
        try {
          const u = await sbGet(
            `gebruikers?select=id&email=eq.${encodeURIComponent(String(gevende_makelaar_email).toLowerCase())}`
          );
          if (u[0]) makelaarId = u[0].id;
        } catch { /* niet kritiek — id mag null blijven */ }
      }

      let rij;
      try {
        rij = await sbInsert('hypotheek_doorverwijzingen', {
          kantoor_id:            MVA_KANTOOR_ID,
          klant_naam:            klant_naam || null,
          klant_email:           klant_email || null,
          klant_telefoon:        klant_telefoon || null,
          voorkeur_adviseur:     voorkeur_adviseur || null,
          type_advies:           type_advies || null,
          opmerking:             opmerking || null,
          gevende_makelaar_id:   makelaarId,
          gevende_makelaar_naam: gevende_makelaar_naam || null,
          bellijst_item_id:      bellijst_item_id ? parseInt(bellijst_item_id) : null,
          bezichtiging_id:       bezichtiging_id ? parseInt(bezichtiging_id) : null,
          mail_verzonden:        false,
        });
      } catch (e) {
        return {
          statusCode: 500, headers,
          body: JSON.stringify({ error: `Registratie hypotheekdoorverwijzing faalde: ${e.message}` }),
        };
      }
      const nieuweId = rij && rij[0] ? rij[0].id : null;

      // 2. Mail naar de Hypotheekshop (CC Ton + doorgevende makelaar)
      let mailOk = false;
      try {
        const cc = [...HYPOTHEEK_CC];
        if (gevende_makelaar_email && !cc.includes(gevende_makelaar_email.toLowerCase())) {
          cc.push(gevende_makelaar_email);
        }
        const html = renderHypotheekMail({
          klantNaam:        klant_naam || '(geen naam)',
          klantEmail:       klant_email || '',
          klantTelefoon:    klant_telefoon || '',
          voorkeurAdviseur: voorkeur_adviseur || '',
          typeAdvies:       type_advies || '',
          opmerking:        opmerking || '',
          gevendeMakelaar:  gevende_makelaar_naam || 'een collega',
          adres:            adres || '',
        });
        const mailRes = await stuurMail({
          to:      HYPOTHEEK_ONTVANGERS,
          cc,
          subject: `Hypotheekdoorverwijzing: ${klant_naam || 'nieuwe klant'}`,
          html,
        });
        mailOk = !!(mailRes && mailRes.ok);
      } catch (e) {
        console.warn('[verwijs_hypotheek] mail faalde (niet kritiek):', e.message);
      }

      // 3. Mail-status terugschrijven (best effort)
      if (nieuweId && mailOk) {
        try {
          await sbPatch(`hypotheek_doorverwijzingen?id=eq.${nieuweId}`, { mail_verzonden: true });
        } catch { /* niet kritiek */ }
      }

      return {
        statusCode: 200, headers,
        body: JSON.stringify({ ok: true, id: nieuweId, mail_verzonden: mailOk }),
      };
    }

    // ── FEEDBACK OPSLAAN ─────────────────────────────────────────────
    if (action === 'sla_feedback_op') {
      const { item_id, feedback, opmerking } = data;

      // feedback komt binnen als CSV-string ('serieus,verkoop') → naar PG ARRAY
      const keys = (feedback || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

      const updated = await sbPatch(`bezichtigingen?id=eq.${item_id}`, {
        feedback_keys:       keys,
        feedback_opmerking:  opmerking || '',
        status_gewijzigd_op: new Date().toISOString(),
      });

      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, item_id, updated_count: updated.length }) };
    }

    // ═════════════════════════════════════════════════════════════════
    // GROEP 2 — BELLIJST-ACTIES (Supabase)
    // ═════════════════════════════════════════════════════════════════
    // Bellijst-items leven in tabel `bellijst_items`. Per makelaar kunnen er
    // items zijn met bron='zelf' (zelf gepushte lead) of bron='pool' (RR).
    //
    // Backwards compatible: response van get_leads heeft dezelfde shape als
    // de oude Monday-versie (id, naam, telefoon, email, adres, datum, status,
    // belpogingen, etc.) zodat public/index.html ongewijzigd kan blijven.

    // ── BELLIJST OPHALEN (ontvangende lijst voor 1 makelaar) ─────────
    if (action === 'get_leads') {
      const { makelaar_naam, makelaar_email, bron } = data;

      // Lookup eigenaar_id via email (voorkeur) of naam
      let eigenaarId = null;
      if (makelaar_email) {
        const u = await sbGet(`gebruikers?select=id&email=eq.${encodeURIComponent(makelaar_email.toLowerCase())}`);
        if (u[0]) eigenaarId = u[0].id;
      }
      if (!eigenaarId && makelaar_naam) {
        const u = await sbGet(`gebruikers?select=id&naam=eq.${encodeURIComponent(makelaar_naam)}`);
        if (u[0]) eigenaarId = u[0].id;
      }
      if (!eigenaarId) {
        return { statusCode: 200, headers, body: JSON.stringify({ leads: [] }) };
      }

      // Filter: actieve bellijst-items
      // - Verberg gearchiveerde leads (lead_status='Gearchiveerd')
      // - Verberg afgesloten via bel_status (legacy: deal/lost via belstatus)
      let path = `bellijst_items?select=*&eigenaar_id=eq.${eigenaarId}` +
        `&bel_status=not.in.(deal,lost)` +
        `&order=toegevoegd_op.desc&limit=500`;
      // Optionele bron-filter (bv. alleen 'pool' tonen)
      if (bron === 'pool' || bron === 'zelf') {
        path += `&bron=eq.${bron}`;
      }
      const items = await sbGet(path);

      // Voor pool-leads: haal gevende makelaar erbij via bezichtigingen-tabel
      // (eigen leads bron='zelf' krijgen geen bij_wie — die zijn van henzelf)
      // Daarnaast halen we voor ÁLLE items met een bezichtiging_id het type op
      // (ingepland / open_huis), zodat de kaart "Open Huis" i.p.v. "Bezichtiging"
      // kan tonen — ook voor eigen leads en open-huis-inschrijvingen.
      const poolItems = items.filter(it => it.bron === 'pool' && it.bezichtiging_id);
      const itemsMetBez = items.filter(it => it.bezichtiging_id);
      let geverPerBezId = {};
      let typePerBezId = {};
      if (itemsMetBez.length > 0) {
        const alleBezIds = [...new Set(itemsMetBez.map(it => it.bezichtiging_id))].join(',');
        const bezichtigingen = await sbGet(`bezichtigingen?select=id,gevende_makelaar_id,type&id=in.(${alleBezIds})`);
        typePerBezId = Object.fromEntries(
          bezichtigingen.map(b => [b.id, b.type || 'ingepland'])
        );
        // Gever-naam alleen nodig voor pool-leads
        const poolBezIds = new Set(poolItems.map(it => it.bezichtiging_id));
        const geverIds = [...new Set(
          bezichtigingen.filter(b => poolBezIds.has(b.id)).map(b => b.gevende_makelaar_id).filter(Boolean)
        )];
        let gebruikersMap = {};
        if (geverIds.length > 0) {
          const gebruikers = await sbGet(`gebruikers?select=id,naam&id=in.(${geverIds.join(',')})`);
          gebruikersMap = Object.fromEntries(gebruikers.map(g => [g.id, g.naam]));
        }
        geverPerBezId = Object.fromEntries(
          bezichtigingen.map(b => [b.id, gebruikersMap[b.gevende_makelaar_id] || ''])
        );
      }

      // ── NO-SHOW TELLER ───────────────────────────────────────────
      // Tel hoe vaak de persoon achter elke lead eerder een no-show had,
      // over ALLE bezichtigingen heen. Match op e-mail (voorkeur) of telefoon
      // — bewezen betrouwbaarder dan naam (zelfde persoon, andere naam-spelling).
      // Eén query voor alle no-show-bezichtigingen, daarna in-memory tellen.
      const persoonSleutel = (email, tel) => {
        const e = (email || '').trim().toLowerCase();
        if (e) return `e:${e}`;
        const t = (tel || '').replace(/[^0-9+]/g, ''); // normaliseer telefoon
        if (t) return `t:${t}`;
        return null;
      };
      let noshowPerSleutel = {};
      try {
        // PostgREST: feedback_keys is een array-kolom; cs.{noshow} = "contains noshow"
        const noshowBez = await sbGet(
          `bezichtigingen?select=bezichtiger_email,bezichtiger_telefoon&feedback_keys=cs.{noshow}`
        );
        for (const b of noshowBez) {
          const sl = persoonSleutel(b.bezichtiger_email, b.bezichtiger_telefoon);
          if (sl) noshowPerSleutel[sl] = (noshowPerSleutel[sl] || 0) + 1;
        }
      } catch (e) {
        console.warn('[get_leads] no-show telling faalde (niet kritiek):', e.message);
      }

      // ── HYPOTHEEK-DOORVERWIJZING LOOKUP ──────────────────────────
      // Toon op de leadkaart of er voor deze klant al een hypotheek-
      // doorverwijzing loopt (Rogier-feedback 26 mei: een collega die de
      // lead doorkrijgt zag niet dat de hypotheek al naar de Hypotheekshop
      // was gestuurd → risico op dubbel doorsturen).
      //
      // Koppeling kan via bellijst_item_id OF bezichtiging_id (een
      // doorverwijzing vanaf een bezichtiging maakt later een NIEUW
      // bellijst-item bij de ontvanger — daarom matchen we ook op
      // bezichtiging_id zodat de info de lead "volgt"). Eén batch-query.
      let hypByItemId = {};   // bellijst_item_id → doorverwijzing
      let hypByBezId  = {};   // bezichtiging_id  → doorverwijzing
      try {
        const itemIds = items.map(it => it.id).filter(Boolean);
        const bezIds  = [...new Set(items.map(it => it.bezichtiging_id).filter(Boolean))];
        if (itemIds.length > 0 || bezIds.length > 0) {
          // PostgREST or(): match op een van beide id-sets
          const orDelen = [];
          if (itemIds.length > 0) orDelen.push(`bellijst_item_id.in.(${itemIds.join(',')})`);
          if (bezIds.length  > 0) orDelen.push(`bezichtiging_id.in.(${bezIds.join(',')})`);
          const hypRijen = await sbGet(
            `hypotheek_doorverwijzingen?select=id,bellijst_item_id,bezichtiging_id,gevende_makelaar_naam,aangemaakt_op,status&or=(${orDelen.join(',')})`
          );
          for (const h of hypRijen) {
            // Nieuwste wint als er meerdere zijn voor hetzelfde id
            if (h.bellijst_item_id) {
              const best = hypByItemId[h.bellijst_item_id];
              if (!best || (h.aangemaakt_op || '') > (best.aangemaakt_op || '')) hypByItemId[h.bellijst_item_id] = h;
            }
            if (h.bezichtiging_id) {
              const best = hypByBezId[h.bezichtiging_id];
              if (!best || (h.aangemaakt_op || '') > (best.aangemaakt_op || '')) hypByBezId[h.bezichtiging_id] = h;
            }
          }
        }
      } catch (e) {
        console.warn('[get_leads] hypotheek-lookup faalde (niet kritiek):', e.message);
      }

      // Transformeer naar Monday-stijl shape voor frontend backwards compat
      const leads = items
        // Filter Gearchiveerd weg (kan ook server-side via .neq= maar PostgREST or-syntax is fragiel met null)
        .filter(it => it.lead_status !== 'Gearchiveerd')
        .map(it => ({
          id:                 String(it.id),
          naam:               it.bezichtiger_naam || '',
          telefoon:           it.bezichtiger_telefoon || '',
          email:              it.bezichtiger_email || '',
          adres:              it.adres || '',
          datum_bezichtiging: it.datum_tijd ? it.datum_tijd.split('T')[0] : '',
          datum:              it.toegevoegd_op ? it.toegevoegd_op.split('T')[0] : '',
          status:             it.bel_status || 'nieuw',
          lead_status:        it.lead_status || null,
          cloze_id:           it.cloze_id || null,
          warme_lead:         it.warme_lead ? 'true' : '',
          opmerkingen:        it.opmerking || '',
          gever_opmerking:    it.gever_opmerking || '',
          no_shows:           noshowPerSleutel[persoonSleutel(it.bezichtiger_email, it.bezichtiger_telefoon)] || 0,
          bron:               it.bron, // 'zelf' of 'pool'
          bez_type:           it.bezichtiging_id ? (typePerBezId[it.bezichtiging_id] || 'ingepland') : 'ingepland',
          bij_wie:            (it.bron === 'pool' && it.bezichtiging_id) ? (geverPerBezId[it.bezichtiging_id] || '') : '',
          belpogingen:        it.belpogingen || 0,
          afspraak_op:        it.afspraak_op || '',
          deal_op:            it.deal_op || '',
          bezichtiging_id:    it.bezichtiging_id, // referentie terug naar origineel
          // Hypotheek-doorverwijzing (null als die er niet is). Match op
          // eigen item-id eerst, anders op gedeeld bezichtiging-id.
          hypotheek:          (() => {
            const h = hypByItemId[it.id] || (it.bezichtiging_id ? hypByBezId[it.bezichtiging_id] : null);
            if (!h) return null;
            return {
              door:  h.gevende_makelaar_naam || '',
              datum: h.aangemaakt_op ? h.aangemaakt_op.split('T')[0] : '',
              status: h.status || 'aangevraagd',
            };
          })(),
        }));

      return { statusCode: 200, headers, body: JSON.stringify({ leads }) };
    }

    // ── DOORGEGEVEN LEADS OPHALEN (voor "gevende kant" dashboard) ───
    // Geeft alle bezichtigingen van deze makelaar die zijn doorgegeven aan
    // de pool, samen met het bijbehorende bellijst_item (= status bij
    // ontvanger). Optionele filters: van/tot (datum), lead_status, ontvanger_id.
    if (action === 'get_doorgegeven_leads') {
      const { makelaar_email, makelaar_naam, van, tot, lead_status, ontvanger_id } = data;

      // 1. Resolve gever-id
      let geverId = null;
      if (makelaar_email) {
        const u = await sbGet(`gebruikers?select=id,naam&email=eq.${encodeURIComponent(makelaar_email.toLowerCase())}`);
        if (u[0]) geverId = u[0].id;
      }
      if (!geverId && makelaar_naam) {
        const u = await sbGet(`gebruikers?select=id,naam&naam=eq.${encodeURIComponent(makelaar_naam)}`);
        if (u[0]) geverId = u[0].id;
      }
      if (!geverId) {
        return { statusCode: 200, headers, body: JSON.stringify({ doorgegeven: [], info: 'gebruiker niet gevonden' }) };
      }

      // 2. Haal bezichtigingen op die deze makelaar heeft doorgegeven aan de pool
      let bezPath = `bezichtigingen?select=*&gevende_makelaar_id=eq.${geverId}&actie_status=eq.pool` +
        `&order=datum_tijd.desc&limit=500`;
      if (van) bezPath += `&datum_tijd=gte.${van}`;
      if (tot) bezPath += `&datum_tijd=lte.${tot}T23:59:59`;
      const bezichtigingen = await sbGet(bezPath);

      if (bezichtigingen.length === 0) {
        return { statusCode: 200, headers, body: JSON.stringify({ doorgegeven: [] }) };
      }

      // 3. Haal alle bijbehorende bellijst_items op in één query (via in.())
      const bezIds = bezichtigingen.map(b => b.id).join(',');
      let belPath = `bellijst_items?select=*&bezichtiging_id=in.(${bezIds})&bron=eq.pool`;
      if (lead_status) belPath += `&lead_status=eq.${encodeURIComponent(lead_status)}`;
      if (ontvanger_id) belPath += `&eigenaar_id=eq.${ontvanger_id}`;
      const bellijstItems = await sbGet(belPath);

      // 4. Haal namen van alle ontvangers op in één query
      const ontvangerIds = [...new Set(bellijstItems.map(i => i.eigenaar_id).filter(Boolean))];
      let gebruikersMap = {};
      if (ontvangerIds.length > 0) {
        const gebruikers = await sbGet(`gebruikers?select=id,naam,email&id=in.(${ontvangerIds.join(',')})`);
        gebruikersMap = Object.fromEntries(gebruikers.map(g => [g.id, g]));
      }

      // 5. Combineer: per bezichtiging het bijbehorende bellijst_item + ontvanger-naam
      const itemMap = Object.fromEntries(bellijstItems.map(i => [i.bezichtiging_id, i]));
      const doorgegeven = bezichtigingen
        .map(b => {
          const item = itemMap[b.id];
          if (!item) return null;  // geen bellijst_item? Skip (filter on lead_status/ontvanger_id liet 'm vallen)
          const ontvanger = gebruikersMap[item.eigenaar_id] || null;
          return {
            bezichtiging_id:    b.id,
            bellijst_item_id:   item.id,
            datum_bezichtiging: b.datum_tijd,
            doorgegeven_op:     item.toegevoegd_op,
            naam:               b.bezichtiger_naam || '',
            adres:              b.adres || '',
            telefoon:           b.bezichtiger_telefoon || '',
            email:              b.bezichtiger_email || '',
            ontvanger_id:       item.eigenaar_id,
            ontvanger_naam:     ontvanger?.naam || '(onbekend)',
            ontvanger_email:    ontvanger?.email || '',
            bel_status:         item.bel_status || 'nieuw',
            lead_status:        item.lead_status || null,
            cloze_id:           item.cloze_id || null,
            belpogingen:        item.belpogingen || 0,
          };
        })
        .filter(Boolean);

      return { statusCode: 200, headers, body: JSON.stringify({ doorgegeven }) };
    }

    // ── ONTVANGEN LEADS OPHALEN (voor "ontvangende kant" dashboard) ─
    // Geeft alle leads die deze makelaar uit de pool heeft ontvangen,
    // samen met de naam van de oorspronkelijke gever.
    // Optionele filters: van/tot (datum), lead_status, gever_id.
    if (action === 'get_ontvangen_leads') {
      const { makelaar_email, makelaar_naam, van, tot, lead_status, gever_id } = data;

      // 1. Resolve ontvanger-id
      let ontvangerId = null;
      if (makelaar_email) {
        const u = await sbGet(`gebruikers?select=id,naam&email=eq.${encodeURIComponent(makelaar_email.toLowerCase())}`);
        if (u[0]) ontvangerId = u[0].id;
      }
      if (!ontvangerId && makelaar_naam) {
        const u = await sbGet(`gebruikers?select=id,naam&naam=eq.${encodeURIComponent(makelaar_naam)}`);
        if (u[0]) ontvangerId = u[0].id;
      }
      if (!ontvangerId) {
        return { statusCode: 200, headers, body: JSON.stringify({ ontvangen: [], info: 'gebruiker niet gevonden' }) };
      }

      // 2. Haal bellijst_items op die deze makelaar uit de pool heeft ontvangen
      let belPath = `bellijst_items?select=*&eigenaar_id=eq.${ontvangerId}&bron=eq.pool` +
        `&order=toegevoegd_op.desc&limit=500`;
      if (van) belPath += `&toegevoegd_op=gte.${van}`;
      if (tot) belPath += `&toegevoegd_op=lte.${tot}T23:59:59`;
      if (lead_status) belPath += `&lead_status=eq.${encodeURIComponent(lead_status)}`;
      const bellijstItems = await sbGet(belPath);

      // Filter Gearchiveerd weg
      const actiefItems = bellijstItems.filter(i => i.lead_status !== 'Gearchiveerd');

      if (actiefItems.length === 0) {
        return { statusCode: 200, headers, body: JSON.stringify({ ontvangen: [] }) };
      }

      // 3. Haal bijbehorende bezichtigingen op (om de gever te vinden)
      const bezIds = actiefItems.map(i => i.bezichtiging_id).filter(Boolean).join(',');
      let bezichtigingen = [];
      if (bezIds) {
        let bezPath = `bezichtigingen?select=id,gevende_makelaar_id&id=in.(${bezIds})`;
        if (gever_id) bezPath += `&gevende_makelaar_id=eq.${gever_id}`;
        bezichtigingen = await sbGet(bezPath);
      }
      const bezMap = Object.fromEntries(bezichtigingen.map(b => [b.id, b]));

      // 4. Filter items op gever_id indien opgegeven
      const itemsGefilterd = gever_id
        ? actiefItems.filter(i => bezMap[i.bezichtiging_id])
        : actiefItems;

      // 5. Haal namen van alle gevers op in één query
      const geverIds = [...new Set(bezichtigingen.map(b => b.gevende_makelaar_id).filter(Boolean))];
      let gebruikersMap = {};
      if (geverIds.length > 0) {
        const gebruikers = await sbGet(`gebruikers?select=id,naam,email&id=in.(${geverIds.join(',')})`);
        gebruikersMap = Object.fromEntries(gebruikers.map(g => [g.id, g]));
      }

      // 6. Combineer
      const ontvangen = itemsGefilterd.map(item => {
        const bez = bezMap[item.bezichtiging_id];
        const gever = bez ? gebruikersMap[bez.gevende_makelaar_id] : null;
        return {
          bellijst_item_id:   item.id,
          bezichtiging_id:    item.bezichtiging_id,
          ontvangen_op:       item.toegevoegd_op,
          datum_bezichtiging: item.datum_tijd,
          naam:               item.bezichtiger_naam || '',
          adres:              item.adres || '',
          telefoon:           item.bezichtiger_telefoon || '',
          email:              item.bezichtiger_email || '',
          gever_id:           bez?.gevende_makelaar_id || null,
          gever_naam:         gever?.naam || '(onbekend)',
          gever_email:        gever?.email || '',
          bel_status:         item.bel_status || 'nieuw',
          lead_status:        item.lead_status || null,
          cloze_id:           item.cloze_id || null,
          belpogingen:        item.belpogingen || 0,
        };
      });

      return { statusCode: 200, headers, body: JSON.stringify({ ontvangen }) };
    }

    // ── BELLIJST STATUS UPDATEN ──────────────────────────────────────
    // ── UPDATE BEL-STATUS (resultaat van een telefoongesprek) ────────
    // Frontend stuurt: { item_id, status } waarbij status één van de oude
    // Monday-keys is (bereikt_ja, bereikt_later, niet_bereikbaar, ...).
    // Vertaal naar onze interne bel_status enum.
    if (action === 'update_status') {
      const { item_id, status, opmerking } = data;

      // Mapping van oude Monday-keys naar nieuwe bel_status enum
      const statusMap = {
        bereikt_ja:          'bereikt',
        bereikt_later:       'bel_terug',
        niet_bereikbaar:     'niet_bereikbaar',
        wellicht_later:      'wellicht_later',
        niet_geinteresseerd: 'niet_geinteresseerd',
        voicemail:           'voicemail',
      };
      const belStatus = statusMap[status] || status;

      // Bouw update body
      const body = {
        bel_status:          belStatus,
        status_gewijzigd_op: new Date().toISOString(),
      };

      // Beller-notitie meeschrijven als die is meegegeven.
      // Let op: dit is de notitie van de BELLER (eigen veld), los van
      // gever_opmerking. Alleen overschrijven als er echt iets is meegegeven
      // (undefined = veld niet aanraken; lege string = bewust leegmaken mag).
      if (typeof opmerking === 'string') {
        body.opmerking = opmerking;
      }

      // Bij niet_bereikbaar / voicemail: belpogingen ophogen
      if (belStatus === 'niet_bereikbaar' || belStatus === 'voicemail') {
        const cur = await sbGet(`bellijst_items?select=belpogingen&id=eq.${item_id}`);
        const huidig = cur[0]?.belpogingen || 0;
        body.belpogingen = huidig + 1;
        body.laatst_gebeld_op = new Date().toISOString();
      } else if (belStatus === 'bereikt') {
        body.laatst_gebeld_op = new Date().toISOString();
      }

      const updated = await sbPatch(`bellijst_items?id=eq.${item_id}`, body);
      return {
        statusCode: 200, headers,
        body: JSON.stringify({ ok: true, item_id, bel_status: belStatus, updated_count: updated.length }),
      };
    }

    // ── UPDATE LEAD-STATUS (kwalificatie van de lead) ─────────────────
    // Frontend stuurt: { item_id, lead_status } met waarden als
    // 'Hot' / 'Warm' / 'Afspraak' / 'Deal' / 'Lost' / 'Gearchiveerd'.
    // Schrijft naar de aparte bellijst_items.lead_status kolom (toegevoegd 10 mei).
    // Bij 'Afspraak' / 'Deal' wordt ook de bijbehorende datum-kolom gevuld.
    if (action === 'update_lead_status') {
      const { item_id, lead_status } = data;
      if (!item_id || !lead_status) {
        return {
          statusCode: 400, headers,
          body: JSON.stringify({ error: 'item_id en lead_status zijn vereist' }),
        };
      }

      const body = {
        lead_status,
        status_gewijzigd_op: new Date().toISOString(),
      };

      // Bij Afspraak/Deal ook de datum-kolommen vullen
      const vandaag = new Date().toISOString().split('T')[0];
      if (lead_status === 'Afspraak') body.afspraak_op = vandaag;
      if (lead_status === 'Deal')     body.deal_op = vandaag;

      // 'warme_lead' boolean ook netjes synchroniseren — true bij Hot/Warm/Afspraak/Deal
      // (oude flow gebruikte deze, zo blijft die in sync voor backward compat).
      const warmeStatussen = ['Hot', 'Warm', 'Afspraak', 'Deal'];
      body.warme_lead = warmeStatussen.includes(lead_status);

      const updated = await sbPatch(`bellijst_items?id=eq.${item_id}`, body);
      return {
        statusCode: 200, headers,
        body: JSON.stringify({ ok: true, item_id, lead_status, updated_count: updated.length }),
      };
    }

    // ── KOPPEL CLOZE-ID AAN BELLIJST-ITEM ─────────────────────────────
    // Frontend roept dit aan na succesvol klant_aanmaken_of_updaten,
    // zodat we de Cloze portableId opslaan op het bellijst-item.
    // Hiermee kan op de lead-kaart een persistente "🔗 Cloze" knop staan.
    if (action === 'set_cloze_id') {
      const { item_id, cloze_id } = data;
      if (!item_id || !cloze_id) {
        return {
          statusCode: 400, headers,
          body: JSON.stringify({ error: 'item_id en cloze_id zijn vereist' }),
        };
      }
      const updated = await sbPatch(`bellijst_items?id=eq.${item_id}`, { cloze_id });
      return {
        statusCode: 200, headers,
        body: JSON.stringify({ ok: true, item_id, cloze_id, updated_count: updated.length }),
      };
    }

    // ── EIGEN BELLIJST-BOARD (legacy: gaf Monday board ID terug) ─────
    // Niet meer relevant — bellijst is nu in Supabase en query is via
    // eigenaar_id, niet via een board_id. Frontend zou dit niet meer
    // hoeven aan te roepen, maar voor backwards compat geven we 'ok=true'.
    if (action === 'get_eigen_bellijst_board') {
      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          ok: true,
          board_id: 'supabase',
          board_label: 'Bellijst (Supabase)',
          info: 'Bellijst leeft nu in Supabase tabel bellijst_items. Gebruik get_leads met makelaar_email.',
        }),
      };
    }

    // ═════════════════════════════════════════════════════════════════
    // GROEP 3 — LEGACY MONDAY ACTIES (debug + meedoen-board)
    // ═════════════════════════════════════════════════════════════════
    // Het Meedoen Leadpool board op Monday is nog wel de bron-of-truth
    // voor wie er meedoet aan RR. Op termijn: gebruikers.doet_mee_round_robin
    // wordt al gebruikt door RR, maar get_makelaars/get_alle_makelaars
    // queryen nog Monday omdat de frontend dropdowns daarop bouwen.

    const MONDAY_TOKEN = process.env.MONDAY_TOKEN;
    const token = MONDAY_TOKEN.startsWith('Bearer ') ? MONDAY_TOKEN : `Bearer ${MONDAY_TOKEN}`;
    const mondayFetch = async (query, variables = {}) => {
      const res = await fetch('https://api.monday.com/v2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: token, 'API-Version': '2024-01' },
        body: JSON.stringify({ query, variables }),
      });
      return res.json();
    };

    // ── DEBUG: KOLOMMEN OPHALEN ──────────────────────────────────────
    if (action === 'get_columns') {
      const result = await mondayFetch(`
        query ($boardId: ID!) {
          boards(ids: [$boardId]) { name columns { id title type } }
        }
      `, { boardId: data.board_id });
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    // ── OUDE MONDAY HANDLERS VERWIJDERD ──────────────────────────────
    // De volgende acties zijn gemigreerd naar Supabase (zie boven):
    //   - get_leads → leest nu uit bellijst_items
    //   - get_eigen_bellijst_board → niet meer nodig (geen board_id)
    //   - update_lead_status → samengevoegd met update_status
    //   - update_status → werkt nu op bellijst_items.bel_status
    // Code rondom Monday's bellijst-boards (5093190545 + 9x bellijst-board)
    // is opgeruimd. BELLIJST_LABELS bovenaan blijft nog wel staan voor het
    // geval er ergens nog een legacy referentie is.

    // ── ALLE MAKELAARS / GET_MAKELAARS ──────────────────────────────
    // ── GET COLLEGA MAKELAARS (voor doorgeef-dropdown) ───────────────
    // Actieve MVA-makelaars uit Supabase, exclusief de aanvrager zelf.
    // Bron is Supabase (niet Monday) zodat de lijst consistent is met de
    // rest van de app. Externs (Filipe/Gert-Jan) doen niet mee aan normale
    // doorgifte binnen MVA en worden eruit gefilterd.
    if (action === 'get_collega_makelaars') {
      const { email } = data || {};
      const lijst = await sbGet(
        `gebruikers?select=id,naam,email,rol&actief=eq.true&kantoor_id=eq.${MVA_KANTOOR_ID}` +
        `&order=naam.asc`
      );
      const eigenEmail = (email || '').toLowerCase();
      const collegas = lijst
        .filter(g => g.rol !== 'extern')
        .filter(g => (g.email || '').toLowerCase() !== eigenEmail)
        .map(g => ({ naam: g.naam, email: g.email }));
      return { statusCode: 200, headers, body: JSON.stringify({ makelaars: collegas }) };
    }

    if (action === 'get_alle_makelaars' || action === 'get_makelaars') {
      const result = await mondayFetch(`{
        boards(ids: [5093235823]) {
          items_page(limit: 50) { items { id name column_values { id text value } } }
        }
      }`);
      const items = result?.data?.boards?.[0]?.items_page?.items || [];
      const makelaars = items.map(item => {
        const cols = item.column_values || [];
        return {
          naam:     item.name,
          email:    cols.find(c => c.id === 'text_mm1nxwsn')?.text || '',
          actief:   cols.find(c => c.id === 'boolean_mm1g4fwm')?.text === 'true',
          meedoen:  cols.find(c => c.id === 'boolean_mm1g4fwm')?.text || '',
          vakantie: cols.find(c => c.id === 'timerange_mm1gj38w')?.text || '',
          board:    cols.find(c => c.id === 'text_mm1gbj3q')?.text || '',
        };
      })
      .filter(m => m.email)
      .filter(m => isMVAMakelaar(m.naam));

      const filtered = (action === 'get_makelaars')
        ? makelaars.filter(m => m.meedoen === 'true' || m.meedoen === 'v')
        : makelaars.sort((a, b) => a.naam.localeCompare(b.naam));

      return { statusCode: 200, headers, body: JSON.stringify({ makelaars: filtered }) };
    }

    // ── GET RR STATUS (eigen) ────────────────────────────────────────
    // Haalt doet_mee_round_robin voor de ingelogde makelaar op. Wordt aangeroepen
    // door de toggle-strook in de bel-lijst om de huidige stand te tonen.
    if (action === 'get_rr_status') {
      const { email } = data || {};
      if (!email) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'email vereist' }) };
      }
      const rows = await sbGet(
        `gebruikers?select=id,naam,email,rol,doet_mee_round_robin,vakantie_van,vakantie_tot` +
        `&email=eq.${encodeURIComponent(email.toLowerCase())}`
      );
      if (!rows.length) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'gebruiker niet gevonden' }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify({ gebruiker: rows[0] }) };
    }

    // ── GET RR STATUS ALLE (admin only) ──────────────────────────────
    // Lijst van alle actieve gebruikers in dit kantoor + hun RR-status.
    // Caller moet email meesturen — backend checkt rol='admin'.
    if (action === 'get_rr_status_alle') {
      const { email } = data || {};
      if (!email) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'email vereist' }) };
      }
      // Auth-check: admin of directie mag iedereen zien
      const aanvrager = await sbGet(
        `gebruikers?select=rol&email=eq.${encodeURIComponent(email.toLowerCase())}`
      );
      const aanvragerRol = aanvrager.length ? aanvrager[0].rol : null;
      if (aanvragerRol !== 'admin' && aanvragerRol !== 'directie') {
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'geen beheerder-rechten' }) };
      }
      const lijst = await sbGet(
        `gebruikers?select=id,naam,email,rol,doet_mee_round_robin,mag_in_round_robin,vakantie_van,vakantie_tot,actief` +
        `&actief=eq.true&kantoor_id=eq.${MVA_KANTOOR_ID}` +
        `&order=naam.asc`
      );
      return { statusCode: 200, headers, body: JSON.stringify({ gebruikers: lijst }) };
    }

    // ── TOGGLE RR ────────────────────────────────────────────────────
    // Zet doet_mee_round_robin voor een gebruiker op de meegestuurde waarde.
    // - Eigen status zetten: aanvrager_email == target_email → altijd toegestaan
    // - Andermans status zetten: aanvrager moet rol='admin' hebben
    if (action === 'toggle_rr') {
      const { aanvrager_email, target_email, waarde } = data || {};
      if (!aanvrager_email || !target_email || typeof waarde !== 'boolean') {
        return {
          statusCode: 400, headers,
          body: JSON.stringify({ error: 'aanvrager_email, target_email en waarde (boolean) vereist' }),
        };
      }
      const aanvragerEmail = aanvrager_email.toLowerCase();
      const targetEmail = target_email.toLowerCase();

      // Auth-check
      if (aanvragerEmail !== targetEmail) {
        const aanvrager = await sbGet(
          `gebruikers?select=rol&email=eq.${encodeURIComponent(aanvragerEmail)}`
        );
        const aanvragerRol = aanvrager.length ? aanvrager[0].rol : null;
        if (aanvragerRol !== 'admin' && aanvragerRol !== 'directie') {
          return {
            statusCode: 403, headers,
            body: JSON.stringify({ error: 'alleen beheerder kan andere gebruikers wijzigen' }),
          };
        }
      }

      // Block: gebruikers met mag_in_round_robin=false kunnen niet aangezet
      // worden. Geldt voor zowel zichzelf als beheerder die het probeert.
      // Dit beschermt externs (Filipe/Gert-Jan) tegen onbedoeld in RR komen.
      if (waarde === true) {
        const targetRows = await sbGet(
          `gebruikers?select=mag_in_round_robin,naam&email=eq.${encodeURIComponent(targetEmail)}`
        );
        const target = targetRows[0];
        if (target && target.mag_in_round_robin === false) {
          return {
            statusCode: 403, headers,
            body: JSON.stringify({
              error: `${target.naam} mag niet aan Round Robin meedoen (externe makelaar)`,
            }),
          };
        }
      }

      // Update
      const result = await sbPatch(
        `gebruikers?email=eq.${encodeURIComponent(targetEmail)}`,
        { doet_mee_round_robin: waarde }
      );

      if (!result || (Array.isArray(result) && result.length === 0)) {
        return {
          statusCode: 404, headers,
          body: JSON.stringify({ error: 'gebruiker niet gevonden of niet bijgewerkt' }),
        };
      }

      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          ok: true,
          target_email: targetEmail,
          doet_mee_round_robin: waarde,
        }),
      };
    }

    // ── ASSIGN MAKELAAR (oude RR, niet meer gebruikt) ────────────────
    // Behouden voor backwards compat — nieuwe flow loopt via push_naar_pool.
    if (action === 'assign_makelaar') {
      return {
        statusCode: 410, headers,
        body: JSON.stringify({ error: 'assign_makelaar is gemigreerd naar push_naar_pool (Round Robin in Supabase)' }),
      };
    }

    return {
      statusCode: 400, headers,
      body: JSON.stringify({ error: `Onbekende actie: ${action}` }),
    };
  } catch (err) {
    return {
      statusCode: 500, headers,
      body: JSON.stringify({ error: err.message, action }),
    };
  }
};
