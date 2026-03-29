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

// Best selling sizes on Vinted UK
const BEST_SIZES = ['s','m','l','xl','8','9','10','uk8','uk9','uk10','size 8','size 9','size 10'];

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

// Get accurate market prices with outlier removal
async function getMarketPrices(query, token) {
  try {
    const q = encodeURIComponent(query);
    const url = 'https://api.ebay.com/buy/browse/v1/item_summary/search?q=' + q + '&limit=30&marketplace_ids=EBAY_GB&sort=endDateSoonest';
    const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_GB' } });
    const data = await r.json();
    const items = data.itemSummaries || [];
    if (!items.length) return null;

    const prices = items
      .map(i => parseFloat(i.price && i.price.value ? i.price.value : 0))
      .filter(p => p > 2)
      .sort((a, b) => a - b);

    if (prices.length < 3) return null;

    // Trim top and bottom 25% to remove outliers
    const trimStart = Math.floor(prices.length * 0.25);
    const trimEnd = Math.ceil(prices.length * 0.75);
    const trimmed = prices.slice(trimStart, trimEnd);
    if (!trimmed.length) return null;

    const avg = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
    const median = trimmed[Math.floor(trimmed.length / 2)];

    return {
      avgPrice: Math.round(avg * 100) / 100,
      medianPrice: Math.round(median * 100) / 100,
      lowPrice: trimmed[0],
      highPrice: trimmed[trimmed.length - 1],
      sampleSize: prices.length,
      trimmedSize: trimmed.length
    };
  } catch (e) { return null; }
}

// Get ending-soon auctions with low bids — the best cheap buys
async function getEndingAuctions(query, token, maxPrice) {
  try {
    const q = encodeURIComponent(query);
    const url = 'https://api.ebay.com/buy/browse/v1/item_summary/search?q=' + q + '&limit=10&marketplace_ids=EBAY_GB&filter=buyingOptions:{AUCTION},price:[0..' + maxPrice + '],priceCurrency:GBP&sort=endDateSoonest';
    const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_GB' } });
    const data = await r.json();
    return (data.itemSummaries || []).filter(item => {
      if (!item.itemEndDate) return false;
      const hoursLeft = (new Date(item.itemEndDate) - new Date()) / 3600000;
      return hoursLeft > 0 && hoursLeft < 6; // ending within 6 hours
    });
  } catch (e) { return []; }
}

// Detect bad photos from title/description signals
function detectBadPhotos(title) {
  const badSigns = ['single photo', 'one photo', 'no photos', 'blurry', 'dark photo'];
  const goodSigns = ['lots of photos', 'many photos', 'detailed photos', 'measurements included'];
  const t = title.toLowerCase();
  if (badSigns.some(s => t.includes(s))) return true;
  // Short generic titles often mean bad photos
  if (title.split(' ').length < 4) return true;
  return false;
}

// Check if item is best-selling size
function isBestSize(title) {
  const t = title.toLowerCase();
  return BEST_SIZES.some(s => t.includes(s));
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', hasId: !!CLIENT_ID, hasSecret: !!CLIENT_SECRET, hasAI: !!ANTHROPIC_KEY });
});

// Main deals endpoint
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

    // Run regular listings + auction sniper in parallel
    const [ebayRes, auctionItems, marketData] = await Promise.all([
      fetch('https://api.ebay.com/buy/browse/v1/item_summary/search?q=' + q + '&limit=15&marketplace_ids=EBAY_GB&filter=price:[' + min + '..' + max + '],priceCurrency:GBP&sort=newlyListed', {
        headers: { 'Authorization': 'Bearer ' + token, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_GB' }
      }),
      getEndingAuctions(searchTerm, token, max),
      getMarketPrices(searchTerm, token)
    ]);

    const ebayData = await ebayRes.json();
    const regularItems = (ebayData.itemSummaries || []).slice(0, 8);

    // Merge regular + auction items, flag auctions
    const allItems = [
      ...regularItems.map(i => ({ ...i, isAuction: false })),
      ...auctionItems.map(i => ({ ...i, isAuction: true }))
    ];

    if (!allItems.length) return res.json({ deals: [] });

    const realSellPrice = marketData ? marketData.medianPrice : avgSell;

    const listingData = allItems.map(l => {
      const price = parseFloat(l.price && l.price.value ? l.price.value : 0);
      if (price <= 0) return null;
      const title = l.title || '';
      const hoursLeft = l.itemEndDate ? Math.round((new Date(l.itemEndDate) - new Date()) / 3600000) : null;
      return {
        id: l.itemId,
        title,
        price,
        condition: l.condition,
        image: l.image ? l.image.imageUrl : null,
        url: l.itemWebUrl,
        endDate: l.itemEndDate || null,
        isAuction: l.isAuction || false,
        hoursLeft: hoursLeft,
        badPhotos: detectBadPhotos(title),
        bestSize: isBestSize(title)
      };
    }).filter(Boolean);

    if (!listingData.length) return res.json({ deals: [] });

    // AI scoring with full intelligence
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        system: 'You are a UK clothing resale expert specialising in Vinted UK and eBay UK. You know exactly what sells, at what price, and how fast on both platforms. Respond ONLY with a valid JSON array, no markdown.',
        messages: [{
          role: 'user',
          content: `Score these eBay UK listings for resale profit. Buyer purchases on eBay, resells on Vinted UK or eBay.

Brand: ${brand}, Category: ${cat}
eBay market median (outliers removed): £${realSellPrice}
${marketData ? 'From ' + marketData.trimmedSize + ' listings. Realistic range: £' + marketData.lowPrice + '-£' + marketData.highPrice : 'Estimated'}

PLATFORM KNOWLEDGE:
- Vinted UK: No seller fees. Buyers pay 20-40% more than eBay for vintage sportswear, streetwear, kids designer. Best for items under £80. Free shipping (built into price) converts much better for items listed under £25.
- Depop UK: No seller fees since 2024. Great for streetwear, vintage, unique pieces. Younger audience, Instagram-style. Commands similar or higher prices to Vinted for hype items.
- eBay UK: 13% fees. Better for football shirts, niche collectibles, higher value items over £80.

BOOST score heavily for:
- Auction ending soon (isAuction:true, hoursLeft low) — potentially very cheap buy
- Bad photos (badPhotos:true) — you can reshoot and list better, easy win
- Best selling size (bestSize:true) — sells faster
- Title words: loft find, unworn, bnwt, never worn, immaculate, perfect, mint, excellent

PENALISE score for:
- Title words: stain, mark, damage, repair, hole, smell, fault, as seen, as is, worn

Only return deals where best platform net profit >= £${MIN_NET_PROFIT}.
eBay net = listPrice * 0.87 - buyPrice
Vinted net = vintedPrice - buyPrice (no fees)
Depop net = depopPrice - buyPrice (no fees)

For EACH listing return:
- id
- tier: "hot" (>80% ROI), "great" (50-80%), "good" (30-50%), "skip" (<30% or profit <£${MIN_NET_PROFIT})
- estSellPrice: realistic eBay sell price
- vintedPrice: realistic Vinted UK sell price
- depopPrice: realistic Depop UK sell price
- vintedListPrice: exact price to list on Vinted (slightly below market to sell in days)
- ebayListPrice: exact eBay Buy It Now price
- bestPlatform: "Vinted", "Depop" or "eBay"
- sellDays: realistic days to sell at recommended price ("1-3", "3-7", "7-14", "14-30")
- vintedTitle: keyword-rich Vinted title (max 60 chars)
- vintedCategory: best Vinted category
- freeShipping: true if should offer free shipping on Vinted
- bundlePotential: true if pairs well with similar items
- photoOpportunity: true if bad photos mean easy win with better photography
- reason: one sentence — why is this a flip?
- liquidity: 1-10
- condFlag: "great", "warn", or "ok"

Only return non-skip items.
Listings: ${JSON.stringify(listingData)}
Return ONLY the JSON array.`
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

      const ebayNet = ((s.estSellPrice || realSellPrice) * 0.87) - orig.price;
      const vintedNet = (s.vintedPrice || realSellPrice * 1.25) - orig.price;
      const depopNet = (s.depopPrice || realSellPrice * 1.2) - orig.price;
      const bestNet = Math.max(ebayNet, vintedNet, depopNet);

      if (bestNet < MIN_NET_PROFIT) return null;

      return {
        ...orig, ...s, cat, brand,
        avgSell: realSellPrice,
        ebayNet: Math.round(ebayNet * 100) / 100,
        vintedNet: Math.round(vintedNet * 100) / 100,
        depopNet: Math.round(depopNet * 100) / 100,
        bestNet: Math.round(bestNet * 100) / 100,
        netProfit: Math.round(bestNet * 100) / 100,
        marketData: marketData || null
      };
    }).filter(Boolean);

    // Sort: hot deals and auctions ending soon first
    deals.sort((a, b) => {
      if (a.isAuction && a.hoursLeft < 3) return -1;
      if (b.isAuction && b.hoursLeft < 3) return 1;
      return b.bestNet - a.bestNet;
    });

    res.json({ deals });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: e.message, deals: [] });
  }
});

app.listen(process.env.PORT || 3000, function() { console.log('FlipRadar proxy running'); });
