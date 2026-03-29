const express = require('express');
const fetch = require('node-fetch');
const app = express();

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json());

const CLIENT_ID = process.env.EBAY_CLIENT_ID;
const CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

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

app.get('/health', (req, res) => res.json({ status: 'ok', hasId: !!CLIENT_ID, hasSecret: !!CLIENT_SECRET, hasAI: !!ANTHROPIC_KEY }));

app.get('/deals', async (req, res) => {
  try {
    const token = await getToken();
    const q = encodeURIComponent(req.query.q || '');
    const min = req.query.minPrice || '0';
    const max = req.query.maxPrice || '25';
    const avgSell = req.query.avgSell || '50';
    const cat = req.query.cat || 'vintage';
    const brand = req.query.brand || '';

    const url = 'https://api.ebay.com/buy/browse/v1/item_summary/search?q=' + q + '&limit=15&marketplace_ids=EBAY_GB&filter=price:[' + min + '..' + max + '],priceCurrency:GBP&sort=newlyListed';
    const ebayRes = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + token, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_GB' }
    });
    const ebayData = await ebayRes.json();
    const items = (ebayData.itemSummaries || []).slice(0, 10);

    if (!items.length) return res.json({ deals: [] });

    const listingData = items.map(l => ({
      id: l.itemId,
      title: l.title,
      price: parseFloat(l.price?.value || 0),
      condition: l.condition,
      image: l.image?.imageUrl || null,
      url: l.itemWebUrl,
      endDate: l.itemEndDate || null
    })).filter(l => l.price > 0);

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        system: 'You are a UK clothing resale expert. Score eBay listings for flip potential. Respond ONLY with a valid JSON array, no markdown.',
        messages: [{
          role: 'user',
          content: `Score these eBay UK listings for flip potential. Brand: ${brand}, Category: ${cat}, Typical resale value: £${avgSell}.

BOOST score if title contains: loft find, unworn, bnwt, never worn, immaculate, perfect, mint, excellent
PENALISE if title contains: stain, mark, damage, repair, hole, smell, fault, as seen

For each return:
- id (same as input)
- tier: "hot" (>80% ROI), "great" (50-80%), "good" (30-50%), "skip" (<30%)
- estSellPrice: realistic UK resale value
- reason: one sentence why it's a flip opportunity
- liquidity: 1-10
- condFlag: "great", "warn", or "ok"

Only return items where tier is NOT skip.
Listings: ${JSON.stringify(listingData)}
Return ONLY the JSON array.`
        }]
      })
    });

    const aiData = await aiRes.json();
    const text = (aiData.content || []).map(b => b.text || '').join('');
    const clean = text.replace(/```json|```/g, '').trim();
    const scored = JSON.parse(clean);

    const seenIds = new Set();
    const deals = scored.map(s => {
      const orig = listingData.find(l => l.id === s.id);
      if (!orig || seenIds.has(orig.id)) return null;
      seenIds.add(orig.id);
      return { ...orig, ...s, cat, brand, avgSell: parseFloat(avgSell) };
    }).filter(Boolean);

    res.json({ deals });

  } catch(e) {
    console.error(e.message);
    res.status(500).json({ error: e.message, deals: [] });
  }
});

app.listen(process.env.PORT || 3000, () => console.log('FlipRadar proxy running'));
