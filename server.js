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

  const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

  const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope'
  });

  const data = await res.json();

  if (!data.access_token) {
    console.error('Token error:', JSON.stringify(data));
    throw new Error('Failed to get token: ' + JSON.stringify(data));
  }

  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  console.log('New eBay token obtained successfully');
  return cachedToken;
}

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    hasClientId: !!CLIENT_ID,
    hasClientSecret: !!CLIENT_SECRET,
    clientIdPreview: CLIENT_ID ? CLIENT_ID.substring(0, 15) + '...' : 'MISSING'
  });
});

app.get('/search', async (req, res) => {
  try {
    const token = await getToken();
    const q = encodeURIComponent(req.query.q || '');
    const minPrice = req.query.minPrice || '';
    const maxPrice = req.query.maxPrice || '';

    let priceFilter = '';
    if (maxPrice) {
      priceFilter = `&filter=price:[${minPrice}..${maxPrice}],priceCurrency:GBP`;
    }

    const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${q}&limit=20&marketplace_ids=EBAY_GB${priceFilter}&sort=newlyListed`;

    const ebayRes = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_GB',
        'Content-Type': 'application/json'
      }
    });

    const data = await ebayRes.json();
    res.json(data);

  } catch (e) {
    console.error('Search error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FlipRadar proxy running on port ${PORT}`));
```

6. Scroll down and click **"Commit changes"**

Render will automatically redeploy. Once it's done first visit:
```
https://flipradar-proxy.onrender.com/health
