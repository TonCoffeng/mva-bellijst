// Netlify Function: push-subscribe.js
// Slaat de push-subscription op van een makelaar (telefoon registratie)

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const { subscription, makelaar_email, makelaar_naam } = JSON.parse(event.body || '{}');

    if (!subscription || !makelaar_email) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Subscription en email vereist' }) };
    }

    // Sla op in Supabase
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    const { error } = await supabase
      .from('push_subscriptions')
      .upsert({
        makelaar_email,
        makelaar_naam,
        subscription: JSON.stringify(subscription),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'makelaar_email' });

    if (error) throw error;

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
