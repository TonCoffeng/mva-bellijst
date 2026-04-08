exports.handler = async (event) => {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const MONDAY_TOKEN  = process.env.MONDAY_TOKEN;

  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  const { action, data } = JSON.parse(event.body || "{}");

  // Haal email van collega op uit Meedoen Leadpool bord
  const getMedewerkerEmail = async (naam) => {
    const token = MONDAY_TOKEN.startsWith("Bearer ") ? MONDAY_TOKEN : `Bearer ${MONDAY_TOKEN}`;
    const res = await fetch("https://api.monday.com/v2", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: token, "API-Version": "2024-01" },
      body: JSON.stringify({
        query: `{ boards(ids: [5093235823]) { items_page(limit: 50) { items { name column_values { id text } } } } }`,
      }),
    });
    const json = await res.json();
    const items = json?.data?.boards?.[0]?.items_page?.items || [];
    const match = items.find(i => i.name.toLowerCase() === naam.toLowerCase());
    return match?.column_values?.find(c => c.id === "text_mm1nxwsn")?.text || "";
  };

  try {
    if (action === "bedank_mail") {
      const { ontvangende_makelaar, ontvangende_email, gevende_makelaar, lead_naam, lead_adres, notitie } = data;

      const gevende_email = await getMedewerkerEmail(gevende_makelaar);

      if (!gevende_email) {
        return {
          statusCode: 400, headers,
          body: JSON.stringify({ error: `Geen email gevonden voor ${gevende_makelaar}. Voeg het toe in het Meedoen Leadpool bord.` }),
        };
      }

      const html = `<!DOCTYPE html><html lang="nl"><head><meta charset="UTF-8">
<style>
  body{font-family:Arial,sans-serif;background:#f4f5f8;margin:0;padding:20px}
  .wrap{max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.08)}
  .top{background:#1A2B5F;padding:28px 32px}.top h1{color:#fff;margin:0;font-size:20px}
  .top p{color:rgba(255,255,255,.65);margin:4px 0 0;font-size:13px}
  .mid{padding:28px 32px}.mid p{color:#374151;font-size:15px;line-height:1.65;margin:0 0 14px}
  .box{background:#f4f5f8;border-left:4px solid #E8500A;border-radius:8px;padding:14px 18px;margin:18px 0}
  .box b{color:#1A2B5F}.box p{margin:4px 0;font-size:14px;color:#6b7280}
  .note{background:#fffbeb;border-left:4px solid #f59e0b;border-radius:8px;padding:14px 18px;margin:18px 0;font-style:italic;color:#92400e;font-size:14px}
  .bot{background:#f9fafb;padding:16px 32px;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af}
</style></head><body>
<div class="wrap">
  <div class="top"><h1>👋 Bedankt voor de lead!</h1><p>MVA Leadpool &bull; Makelaars Van Amsterdam</p></div>
  <div class="mid">
    <p>Hoi <b>${gevende_makelaar}</b>,</p>
    <p>Ik heb zojuist contact gehad met een klant van jouw bezichtiging en wil je even laten weten dat ik er goed mee aan de slag ga. Bedankt dat je deze lead hebt vrijgegeven!</p>
    <div class="box">
      <b>📋 Lead details</b>
      <p>👤 Klant: <b style="color:#1A2B5F">${lead_naam}</b></p>
      ${lead_adres ? `<p>📍 Bezichtigd pand: ${lead_adres}</p>` : ""}
    </div>
    ${notitie ? `<div class="note">💬 "${notitie}"</div>` : ""}
    <p>Met vriendelijke groet,<br><b style="color:#E8500A">${ontvangende_makelaar}</b></p>
  </div>
  <div class="bot">MVA Leadpool &bull; Automatisch verstuurd via de MVA Bellijst app</div>
</div></body></html>`;

      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_API_KEY}` },
        body: JSON.stringify({
          from: "MVA Leadpool <noreply@makelaarsvan.nl>",
          to: [gevende_email],
          reply_to: ontvangende_email,
          subject: `✅ ${ontvangende_makelaar} heeft contact gehad met ${lead_naam}`,
          html,
        }),
      });

      const result = await res.json();
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: "Onbekende actie" }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
