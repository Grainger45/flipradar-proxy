const express = require('express');
const fetch = require('node-fetch');
const app = express();

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  next();
});

const CLIENT_ID = process.env.EBAY_CLIENT_ID;
const CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET;
let cachedToken = null;
let tokenExpiry = 0;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const creds = Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64');
  const r = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Authorization': 'Basic ' + creds, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope'
  });
  const d = await r.json();
  if (!d.access_token) throw new Error(JSON.stringify(d));
  cachedToken = d.access_token;
  tokenExpiry = Date.now() + (d.expires_in - 60) * 1000;
  return cachedToken;
}

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.get('/search', async (req, res) => {
  try {
    const token = await getToken();
    const q = encodeURIComponent(req.query.q || '');
    const min = req.query.minPrice || '0';
    const max = req.query.maxPrice || '25';
    const url = 'https://api.ebay.com/buy/browse/v1/item_summary/search?q=' + q + '&limit=20&marketplace_ids=EBAY_GB&filter=price:[' + min + '..' + max + '],priceCurrency:GBP&sort=newlyListed';
    const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_GB' } });
    res.json(await r.json());
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(process.env.PORT || 3000, () => console.log('FlipRadar proxy running'));
