
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
const BEST_SIZES = ['s','m','l','xl','uk8','uk9','uk10','size 8','size 9','size 10'];

// Words that mean the item should be skipped entirely before AI scoring
const HARD_REJECT_WORDS = [
  'reproduction','replica','retro remake','re-make','reprint','bootleg',
  'badge','pin','pennant','programme','program','scarf','poster','mug',
  'sticker','patch','keyring','book','magazine','dvd','vhs','photo',
  'trading card','card','ticket','memorabilia only','figurine','statue',
  'from usa','from us','ships from usa','located in usa','united states',
  'dirty','heavily worn','major stain','ripped','torn','broken zip',
  'bundle of badges','job lot badges','collection of badges'
];

// Condition red flags — penalise but don't auto-reject
const COND_WARN = ['stain','mark','marks','faded','damage','damaged','repair','hole','smell','fault','faulty','as seen','as is','worn','well worn','tatty','grubby','needs clean'];

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

// Check if listing should be hard-rejected before AI scoring
function shouldReject(item) {
  const text = ((item.title || '') + ' ' + (item.itemLocation?.country || '') + ' ' + (item.condition || '')).toLowerCase();
  // Reject non-UK sellers
  if (item.itemLocation && item.itemLocation.country && item.itemLocation.country !== 'GB') return 'non-UK seller';
  // Reject based on title keywords
  for (const word of HARD_REJECT_WORDS) {
    if (text.includes(word)) return 'rejected: ' + word;
  }
  return null;
}

function detectBadPhotos(title) {
  const t = title.toLowerCase();
  return t.split(' ').length < 4;
}

function isBestSize(title) {
  const t = title.toLowerCase();
  return BEST_SIZES.some(s => t.includes(s));
}

// Get accurate market prices with outlier removal — UK only
async function getMarketPrices(query, token) {
  try {
    const q = encodeURIComponent(query);
    const url = 'https://api.ebay.com/buy/browse/v1/item_summary/search?q=' + q + '&limit=30&marketplace_ids=EBAY_GB&filter=itemLocationCountry:GB&sort=endDateSoonest';
    const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_GB' } });
    const data = await r.json();
    const items = (data.itemSummaries || []).filter(i => !shouldReject(i));
    if (!items.length) return null;

    const prices = items
      .map(i => parseFloat(i.price && i.price.value ? i.price.value : 0))
      .filter(p => p > 2)
      .sort((a, b) => a - b);

    if (prices.length < 3) return null;

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

// Get ending-soon UK auctions
async function getEndingAuctions(query, token, maxPrice) {
  try {
    const q = encodeURIComponent(query);
    const url = 'https://api.ebay.com/buy/browse/v1/item_summary/search?q=' + q + '&limit=10&marketplace_ids=EBAY_GB&filter=buyingOptions:{AUCTION},price:[0..' + maxPrice + '],priceCurrency:GBP,itemLocationCountry:GB&sort=endDateSoonest';
    const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_GB' } });
    const data = await r.json();
    return (data.itemSummaries || []).filter(item => {
      if (shouldReject(item)) return false;
      if (!item.itemEndDate) return false;
      const hoursLeft = (new Date(item.itemEndDate) - new Date()) / 3600000;
      return hoursLeft > 0 && hoursLeft < 6;
    });
  } catch (e) { return []; }
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

    // UK only filter added to main search
    const url = 'https://api.ebay.com/buy/browse/v1/item_summary/search?q=' + q +
      '&limit=20&marketplace_ids=EBAY_GB' +
      '&filter=price:[' + min + '..' + max + '],priceCurrency:GBP,itemLocationCountry:GB' +
      '&sort=newlyListed';

    const [ebayRes, auctionItems, marketData] = await Promise.all([
      fetch(url, { headers: { 'Authorization': 'Bearer ' + token, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_GB' } }),
      getEndingAuctions(searchTerm, token, max),
      getMarketPrices(searchTerm, token)
    ]);

    const ebayData = await ebayRes.json();
    const regularItems = (ebayData.itemSummaries || []).slice(0, 12);

    // Merge and hard-filter before AI
    const allItems = [
      ...regularItems.map(i => ({ ...i, isAuction: false })),
      ...auctionItems.map(i => ({ ...i, isAuction: true }))
    ];

    const realSellPrice = marketData ? marketData.medianPrice : avgSell;

    // Hard reject non-UK, reproductions, non-clothing items BEFORE sending to AI
    const listingData = allItems.map(l => {
      const rejectReason = shouldReject(l);
      if (rejectReason) return null;
      const price = parseFloat(l.price && l.price.value ? l.price.value : 0);
      if (price <= 0) return null;
      const title = l.title || '';
      const condText = (l.condition || '').toLowerCase();
      const titleLower = title.toLowerCase();
      const hasCondWarn = COND_WARN.some(w => titleLower.includes(w) || condText.includes(w));
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
        hoursLeft,
        badPhotos: detectBadPhotos(title),
        bestSize: isBestSize(title),
        hasCondWarn,
        country: l.itemLocation ? l.itemLocation.country : 'GB'
      };
    }).filter(Boolean);

    if (!listingData.length) return res.json({ deals: [] });

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        system: 'You are a UK clothing resale expert specialising in Vinted UK and eBay UK. All listings are from UK sellers only. Respond ONLY with a valid JSON array, no markdown.',
        messages: [{
          role: 'user',
          content: `Score these UK eBay listings for resale profit. Buyer purchases on eBay UK, resells on Vinted UK or Depop.

Brand: ${brand}, Category: ${cat}
eBay UK median sell price (UK sellers only, outliers removed): £${realSellPrice}
${marketData ? 'From ' + marketData.trimmedSize + ' UK listings. Realistic range: £' + marketData.lowPrice + '-£' + marketData.highPrice : 'Estimated'}

IMPORTANT RULES:
1. These are all UK sellers — no overseas shipping concerns
2. SKIP anything that looks like: badge, pin, scarf, programme, poster, card, patch, figurine, book — we only want CLOTHING
3. SKIP reproductions, replicas, remakes — only original vintage items have resale value
4. SKIP anything with hasCondWarn:true unless the price is extremely low and profit still >£${MIN_NET_PROFIT}
5. Football shirts: only original vintage shirts from real eras, not modern reproductions

BOOST score: loft find, unworn, bnwt, never worn, immaculate, perfect, mint, excellent, no damage, deadstock
PENALISE: stain, mark, damage, repair, hole, smell, fault, as seen, worn, faded, grubby, tatty

Platforms:
- Vinted UK: no seller fees, 20-40% higher prices than eBay for vintage sportswear/streetwear
- Depop UK: no seller fees, great for streetwear/vintage, similar to Vinted prices
- eBay UK: 13% fees, better for niche/football shirts/higher value items

Only return deals where best platform net profit >= £${MIN_NET_PROFIT}.

For each return:
- id
- tier: "hot" (>80% ROI), "great" (50-80%), "good" (30-50%), "skip" (<30% or profit <£${MIN_NET_PROFIT} or non-clothing or reproduction)
- estSellPrice: realistic eBay UK sell price
- vintedPrice: realistic Vinted UK sell price
- depopPrice: realistic Depop UK sell price
- vintedListPrice: exact Vinted listing price
- ebayListPrice: exact eBay Buy It Now price
- bestPlatform: "Vinted", "Depop" or "eBay"
- sellDays: "1-3", "3-7", "7-14", or "14-30"
- vintedTitle: keyword-rich Vinted title max 60 chars
- vintedCategory: Vinted category
- freeShipping: true if should offer free shipping on Vinted
- bundlePotential: true if pairs well with similar items
- photoOpportunity: true if bad photos = easy win
- reason: one sentence flip opportunity
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

    // Sort: urgent auctions first, then by profit
    deals.sort((a, b) => {
      if (a.isAuction && a.hoursLeft < 3) return -1;
      if (b.isAuction && b.hoursLeft < 3) return 1;
      return b.bestNet - a.bestNet;
    });

    console.log(searchTerm + ': ' + allItems.length + ' found → ' + listingData.length + ' passed filter → ' + deals.length + ' deals');
    res.json({ deals });

  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: e.message, deals: [] });
  }
});

app.listen(process.env.PORT || 3000, function() { console.log('FlipRadar proxy running'); });
