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
const MIN_NET_PROFIT = 15;

let cachedToken = null;
let tokenExpiry = 0;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  const creds = Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64');
  const r = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + creds,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope'
  });
  const d = await r.json();
  if (!d.access_token) throw new Error(JSON.stringify(d));
  cachedToken = d.access_token;
  tokenExpiry = Date.now() + (d.expires_in - 60) * 1000;
  return cachedToken;
}

async function getSoldPrices(query, token) {
  try {
    const q = encodeURIComponent(query);
    const url = 'https://api.ebay.com/buy/browse/v1/item_summary/search?q=' + q + '&limit=20&marketplace_ids=EBAY_GB&filter=buyingOptions:{FIXED_PRICE}&sort=endDateSoonest';
    const r = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + token, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_GB' }
    });
    const data = await r.json();
    const items = data.itemSummaries || [];
    if (!items.length) return null;
    const prices = items.map(i => parseFloat(i.price && i.price.value ? i.price.value : 0)).filter(p => p > 0).sort((a, b) => a - b);
    if (!prices.length) return null;
    const trimmed = prices.slice(Math.floor(prices.length * 0.2), Math.ceil(prices.length * 0.8));
    const avg = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
    return {
      avgPrice: Math.round(avg * 100) / 100,
      minPrice: prices[0],
      maxPrice: prices[prices.length - 1],
      sampleSize: prices.length
    };
  } catch (e) {
    return null;
  }
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', hasId: !!CLIENT_ID, hasSecret: !!CLIENT_SECRET, hasAI: !!ANTHROPIC_KEY });
});

app.get('/deals', async (req, res) => {
  try {
    const token = await getToken();
    const searchTerm = req.query.q || '';
    const q = encodeURIComponent(searchTerm);
    const min = req.query.minPrice || '0';
    const max = req.query.maxPrice || '40';
    const avgSell = parseFloat(req.query.avgSell || '50');
    const cat = req.query.cat || 'vintage';
    const brand = req.query.brand || '';

    const url = 'https://api.ebay.com/buy/browse/v1/item_summary/search?q=' + q + '&limit=15&marketplace_ids=EBAY_GB&filter=price:[' + min + '..' + max + '],priceCurrency:GBP&sort=newlyListed';
    const ebayRes = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_GB' } });
    const ebayData = await ebayRes.json();
    const items = (ebayData.itemSummaries || []).slice(0, 10);
    if (!items.length) return res.json({ deals: [] });

    const soldData = await getSoldPrices(searchTerm, token);
    const realSellPrice = soldData ? soldData.avgPrice : avgSell;

    const listingData = items.map(l => ({
      id: l.itemId,
      title: l.title,
      price: parseFloat(l.price && l.price.value ? l.price.value : 0),
      condition: l.condition,
      image: l.image ? l.image.imageUrl : null,
      url: l.itemWebUrl,
      endDate: l.itemEndDate || null
    })).filter(l => l.price > 0);

    if (!listingData.length) return res.json({ deals: [] });

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1000,
        system: 'You are a UK clothing resale expert. Respond ONLY with a valid JSON array, no markdown.',
        messages: [{
          role: 'user',
          content: 'Score these eBay UK listings. Brand: ' + brand + ', Category: ' + cat + '. Real average sell price on eBay right now: £' + realSellPrice + ' (from ' + (soldData ? soldData.sampleSize + ' real listings, range £' + soldData.minPrice + '-£' + soldData.maxPrice : 'estimated') + '). Only return deals where (sellPrice * 0.87) - buyPrice >= ' + MIN_NET_PROFIT + '. BOOST: loft find, unworn, bnwt, never worn, excellent, mint. PENALISE: stain, mark, damage, hole, smell, fault, as seen. Return for each: id, tier (hot/>80% ROI, great/50-80%, good/30-50%, skip), estSellPrice (base on £' + realSellPrice + ' adjusted for condition), reason (one sentence), liquidity (1-10), condFlag (great/warn/ok). Only non-skip items. Listings: ' + JSON.stringify(listingData) + ' Return ONLY JSON array.'
        }]
      })
    });

    const aiData = await aiRes.json();
    const text = (aiData.content || []).map(b => b.text || '').join('');
    const clean = text.replace(/```json|```/g, '').trim();
    let scored = [];
    try { scored = JSON.parse(clean); } catch (e) { return res.json({ deals: [] }); }

    const seenIds = new Set();
    const deals = scored.map(s => {
      const orig = listingData.find(l => l.id === s.id);
      if (!orig || seenIds.has(orig.id)) return null;
      seenIds.add(orig.id);
      const sellPrice = s.estSellPrice || realSellPrice;
      const netProfit = (sellPrice * 0.87) - orig.price;
      if (netProfit < MIN_NET_PROFIT) return null;
      return { ...orig, ...s, cat, brand, avgSell: realSellPrice, netProfit: Math.round(netProfit * 100) / 100, soldData: soldData || null };
    }).filter(Boolean);

    res.json({ deals });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: e.message, deals: [] });
  }
});

app.listen(process.env.PORT || 3000, function() { console.log('FlipRadar proxy running'); });
