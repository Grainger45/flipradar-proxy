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
  const creds = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope'
  });
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

app.get('/search', async (req, res) => {
  try {
    const token = await getToken();
    const q = encodeURIComponent(req.query.q || '');
    const minPrice = req.query.minPrice || '';
    const maxPrice = req.query.maxPrice || '';
    let priceFilter = '';
    if (minPrice || maxPrice) {
      priceFilter = `&filter=price:[${minPrice}..${maxPrice}],priceCurrency:GBP`;
    }
    const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${q}&limit=20&marketplace_ids=EBAY_GB${priceFilter}&sort=newlyListed`;
    const ebayRes = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_GB'
      }
    });
    const data = await ebayRes.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(process.env.PORT || 3000, () => console.log('FlipRadar proxy running'));
