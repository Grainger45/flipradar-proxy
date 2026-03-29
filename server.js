const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const app = express();

app.use(cors());
app.use(express.json());

const CLIENT_ID = process.env.EBAY_CLIENT_ID;
const CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET;

let cachedToken = null;
let tokenExpiry = 0;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const credentials = Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64');
  const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + credentials,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope'
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error('Token failed: ' + JSON.stringify(data));
  }
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

app.get('/health', function(req, res) {
  res.json({ status: 'ok', hasId: !!CLIENT_ID, hasSecret: !!CLIENT_SECRET });
});

app.get('/search', async function(req, res) {
  try {
    const token = await getToken();
    const q = encodeURIComponent(req.query.q || '');
    const min = req.query.minPrice || '0';
    const max = req.query.maxPrice || '25';
    const filter = '&filter=price:[' + min + '..' + max + '],priceCurrency:GBP';
    const url = 'https://api.ebay.com/buy/browse/v1/item_summary/search?q=' + q + '&limit=20&marketplace_ids=EBAY_GB' + filter + '&sort=newlyListed';
    const ebayRes = await fetch(url, {
      headers: {
        'Authorization': 'Bearer ' + token,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_GB'
      }
    });
    const data = await ebayRes.json();
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(process.env.PORT || 3000, function() {
  console.log('FlipRadar proxy running');
});
