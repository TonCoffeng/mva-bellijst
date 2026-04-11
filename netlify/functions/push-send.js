// Netlify Function: push-send.js
// Stuurt een push notificatie naar een makelaar

const webpush = require('web-push');
const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const { makelaar_email, title, body, url } = JSON.parse(event.body || '{}');

    webpush.setVapidDetails(
      'mailto:toncoffeng@makelaarsvan.nl',
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );

    // Haal subscription op uit Supabase
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    const { data, error } = await supabase
      .from('push_subscriptions')
      .select('subscription')
      .eq('makelaar_email', makelaar_email)
      .single();

    if (error || !data) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Geen subscription gevonden voor ' + makelaar_email }) };
    }

    const subscription = JSON.parse(data.subscription);

    await webpush.sendNotification(subscription, JSON.stringify({
      title: title || 'MVA Bellijst',
      body: body || 'Bezichtiging feedback vereist',
      url: url || '/',
      icon: '/icon-192.png',
    }));

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
