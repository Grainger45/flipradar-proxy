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
const MIN_NET_PROFIT = 12;
const BEST_SIZES = ['s','m','l','xl','uk8','uk9','uk10','size 8','size 9','size 10'];

const HARD_REJECT_WORDS = [
  'reproduction','replica','retro remake','re-make','reprint','bootleg',
  'badge','pin','pennant','programme','program','scarf','poster','mug',
  'sticker','patch','keyring','book','magazine','dvd','vhs','photo',
  'trading card','card','ticket','memorabilia only','figurine','statue',
  'dirty','heavily worn','major stain','ripped','torn','broken zip',
  'bundle of badges','job lot badges','collection of badges'
];

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

function shouldReject(item) {
  const text = ((item.title || '') + ' ' + (item.condition || '')).toLowerCase();
  if (item.itemLocation && item.itemLocation.country && item.itemLocation.country !== 'GB') return 'non-UK';
  for (const word of HARD_REJECT_WORDS) {
    if (text.includes(word)) return 'rejected: ' + word;
  }
  return null;
}

function detectBadPhotos(title) { return title.split(' ').length < 4; }
function isBestSize(title) { const t = title.toLowerCase(); return BEST_SIZES.some(s => t.includes(s)); }

// Get eBay market prices — UK only, outliers removed
async function getMarketPrices(query, token) {
  try {
    const q = encodeURIComponent(query);
    const url = 'https://api.ebay.com/buy/browse/v1/item_summary/search?q=' + q + '&limit=30&marketplace_ids=EBAY_GB&filter=itemLocationCountry:GB&sort=endDateSoonest';
    const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_GB' } });
    const data = await r.json();
    const items = (data.itemSummaries || []).filter(i => !shouldReject(i));
    if (!items.length) return null;
    const prices = items.map(i => parseFloat(i.price?.value || 0)).filter(p => p > 2).sort((a, b) => a - b);
    if (prices.length < 3) return null;
    const trimmed = prices.slice(Math.floor(prices.length * 0.25), Math.ceil(prices.length * 0.75));
    if (!trimmed.length) return null;
    const median = trimmed[Math.floor(trimmed.length / 2)];
    return {
      medianPrice: Math.round(median * 100) / 100,
      lowPrice: trimmed[0],
      highPrice: trimmed[trimmed.length - 1],
      sampleSize: prices.length,
      trimmedSize: trimmed.length
    };
  } catch (e) { return null; }
}

// Get REAL Vinted UK prices by fetching public search results
async function getVintedPrices(query) {
  try {
    const q = encodeURIComponent(query);
    const url = 'https://www.vinted.co.uk/api/v2/catalog/items?search_text=' + q + '&per_page=30&currency=GBP&country_codes[]=GB&order=relevance';
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-GB,en;q=0.9',
        'Referer': 'https://www.vinted.co.uk/',
        'Origin': 'https://www.vinted.co.uk'
      },
      signal: AbortSignal.timeout(8000)
    });

    if (!r.ok) return null;
    const data = await r.json();
    const items = data.items || [];
    if (!items.length) return null;

    const prices = items
      .map(i => parseFloat(i.price || 0))
      .filter(p => p > 1)
      .sort((a, b) => a - b);

    if (prices.length < 3) return null;

    // Remove top and bottom 20% to eliminate outliers
    const trimStart = Math.floor(prices.length * 0.2);
    const trimEnd = Math.ceil(prices.length * 0.8);
    const trimmed = prices.slice(trimStart, trimEnd);
    if (!trimmed.length) return null;

    const median = trimmed[Math.floor(trimmed.length / 2)];
    const low = trimmed[0];
    const high = trimmed[trimmed.length - 1];
    const totalListings = items.length;

    // Calculate recommended listing price based on competition
    let recommendedPrice, listingAdvice, sellDays;
    if (totalListings <= 5) {
      // Low competition — list at or slightly above median
      recommendedPrice = Math.round(median * 1.08);
      listingAdvice = 'Low competition — list confidently above median';
      sellDays = '3-7';
    } else if (totalListings <= 15) {
      // Medium competition — list just below median
      recommendedPrice = Math.round(median * 0.97);
      listingAdvice = 'Medium competition — list just below median to stand out';
      sellDays = '5-10';
    } else {
      // High competition — list noticeably below median
      recommendedPrice = Math.round(median * 0.92);
      listingAdvice = 'High competition — price aggressively to sell';
      sellDays = '7-14';
    }

    return {
      medianPrice: Math.round(median * 100) / 100,
      lowPrice: low,
      highPrice: high,
      totalListings,
      trimmedSize: trimmed.length,
      recommendedPrice,
      listingAdvice,
      sellDays,
      isReal: true
    };
  } catch (e) {
    console.log('Vinted fetch failed:', e.message);
    return null;
  }
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

// Search Oxfam Online for cheap charity shop finds
async function searchOxfam(query, maxPrice) {
  try {
    const q = encodeURIComponent(query);
    const url = 'https://www.oxfam.org.uk/search/?q=' + q + '&department=clothes&price_max=' + maxPrice + '&in_stock=true&sort=newest';
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-GB,en;q=0.9'
      },
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) return [];
    const html = await r.text();

    // Parse product listings from HTML
    const items = [];
    const productRegex = /<article[^>]*class="[^"]*product[^"]*"[^>]*>([\s\S]*?)<\/article>/gi;
    let match;
    while ((match = productRegex.exec(html)) !== null) {
      const block = match[1];
      const titleMatch = block.match(/class="[^"]*product[^"]*title[^"]*"[^>]*>([^<]+)</i) ||
                         block.match(/alt="([^"]+)"/i);
      const priceMatch = block.match(/£([\d.]+)/);
      const urlMatch = block.match(/href="(\/shop\/[^"]+)"/i);
      const imgMatch = block.match(/src="(https?:\/\/[^"]*oxfam[^"]*\.(?:jpg|jpeg|png|webp)[^"]*)"/i);

      if (titleMatch && priceMatch && urlMatch) {
        const price = parseFloat(priceMatch[1]);
        if (price > 0 && price <= parseFloat(maxPrice)) {
          items.push({
            id: 'oxfam-' + Math.random().toString(36).substr(2, 9),
            title: titleMatch[1].trim(),
            price,
            condition: 'Used',
            image: imgMatch ? imgMatch[1] : null,
            url: 'https://www.oxfam.org.uk' + urlMatch[1],
            source: 'Oxfam',
            isAuction: false,
            hoursLeft: null,
            hasCondWarn: false,
            badPhotos: false,
            bestSize: isBestSize(titleMatch[1])
          });
        }
      }
    }
    console.log('Oxfam: found ' + items.length + ' items for "' + query + '"');
    return items.slice(0, 8);
  } catch (e) {
    console.log('Oxfam fetch failed:', e.message);
    return [];
  }
}

app.get('/deals', async (req, res) => {
  try {
    const token = await getToken();
    const searchTerm = req.query.q || '';
    const q = encodeURIComponent(searchTerm);
    const min = req.query.minPrice || '0';
    const max = req.query.maxPrice || '25';
    const avgSell = parseFloat(req.query.avgSell || '45');
    const cat = req.query.cat || 'vintage';
    const brand = req.query.brand || '';
    const vintedSearch = req.query.vintedQ || searchTerm;

    // Run all data fetching in parallel — eBay + Oxfam + market data
    const [ebayRes, auctionItems, marketData, vintedData, oxfamItems] = await Promise.all([
      fetch('https://api.ebay.com/buy/browse/v1/item_summary/search?q=' + q + '&limit=20&marketplace_ids=EBAY_GB&filter=price:[' + min + '..' + max + '],priceCurrency:GBP,itemLocationCountry:GB&sort=newlyListed', {
        headers: { 'Authorization': 'Bearer ' + token, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_GB' }
      }),
      getEndingAuctions(searchTerm, token, max),
      getMarketPrices(searchTerm, token),
      getVintedPrices(vintedSearch),
      searchOxfam(searchTerm, max)
    ]);

    const ebayData = await ebayRes.json();
    const regularItems = (ebayData.itemSummaries || []).slice(0, 10);

    // Merge eBay + Oxfam + auction items
    const allItems = [
      ...regularItems.map(i => ({ ...i, isAuction: false, source: 'eBay' })),
      ...auctionItems.map(i => ({ ...i, isAuction: true, source: 'eBay' })),
      ...oxfamItems
    ];

    if (!allItems.length) return res.json({ deals: [] });

    const realEbaySell = marketData ? marketData.medianPrice : avgSell;
    const realVintedSell = vintedData ? vintedData.medianPrice : null;
    const effectiveSell = realVintedSell || realEbaySell;

    const listingData = allItems.map(l => {
      // Oxfam items already formatted correctly
      if (l.source === 'Oxfam') return l;
      if (shouldReject(l)) return null;
      const price = parseFloat(l.price?.value || 0);
      if (price <= 0) return null;
      const title = l.title || '';
      const titleLower = title.toLowerCase();
      const hasCondWarn = COND_WARN.some(w => titleLower.includes(w));
      const hoursLeft = l.itemEndDate ? Math.round((new Date(l.itemEndDate) - new Date()) / 3600000) : null;
      return {
        id: l.itemId, title, price,
        condition: l.condition,
        image: l.image ? l.image.imageUrl : null,
        url: l.itemWebUrl,
        source: 'eBay',
        endDate: l.itemEndDate || null,
        isAuction: l.isAuction || false,
        hoursLeft, hasCondWarn,
        badPhotos: detectBadPhotos(title),
        bestSize: isBestSize(title)
      };
    }).filter(Boolean);

    if (!listingData.length) return res.json({ deals: [] });

    // AI scoring — uses real Vinted data as anchor
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        system: 'You are a UK clothing resale expert. Respond ONLY with a valid JSON array, no markdown.',
        messages: [{
          role: 'user',
          content: `Score these UK eBay listings for resale on Vinted UK.

Brand: ${brand}, Category: ${cat}
eBay UK median sell price: £${realEbaySell}
${marketData ? 'eBay range (outliers removed): £' + marketData.lowPrice + '–£' + marketData.highPrice : ''}
${vintedData && vintedData.isReal ? `
REAL VINTED UK DATA (fetched live):
- Active listings: ${vintedData.totalListings}
- Median price: £${vintedData.medianPrice}
- Realistic range: £${vintedData.lowPrice}–£${vintedData.highPrice}
- Recommended list price: £${vintedData.recommendedPrice}
- Competition level: ${vintedData.totalListings <= 5 ? 'LOW' : vintedData.totalListings <= 15 ? 'MEDIUM' : 'HIGH'}
USE THIS REAL DATA for all Vinted price estimates. Do not guess.` : `No live Vinted data — estimate conservatively based on eBay prices. Vinted is rarely more than 15% above eBay for most items.`}

RULES:
1. UK sellers only — already filtered
2. SKIP: badges, pins, scarves, programmes, posters, cards, non-clothing items
3. SKIP: reproductions, replicas, fakes
4. SKIP: hasCondWarn:true items unless price is very low and profit still >= £${MIN_NET_PROFIT}
5. Only return deals where Vinted net profit (sell price - buy price, no fees) >= £${MIN_NET_PROFIT}

BOOST: loft find, unworn, bnwt, never worn, immaculate, mint, excellent, deadstock
PENALISE: stain, damage, hole, smell, fault, as seen, worn, faded, tatty

For each listing return:
- id
- tier: "hot" (>80% ROI), "great" (50-80%), "good" (30-50%), "skip" (anything else)
- vintedListPrice: exact price to list on Vinted (use real data if available)
- ebayListPrice: exact eBay Buy It Now price
- vintedNet: vintedListPrice - buyPrice (no fees on Vinted)
- bestPlatform: "Vinted" or "eBay"
- sellDays: realistic days to sell ("1-3", "3-7", "7-14")
- vintedTitle: keyword-rich Vinted title max 60 chars
- vintedCategory: Vinted category
- freeShipping: true if should offer free shipping on Vinted
- bundlePotential: true if pairs well with similar items
- photoOpportunity: true if bad photos = easy win with better photography
- reason: one sentence — why buy this and what to list it as on Vinted
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

      const vintedNet = (s.vintedListPrice || effectiveSell) - orig.price;
      const ebayNet = ((s.ebayListPrice || realEbaySell) * 0.87) - orig.price;
      const bestNet = Math.max(vintedNet, ebayNet);

      if (bestNet < MIN_NET_PROFIT) return null;

      return {
        ...orig, ...s, cat, brand,
        avgSell: effectiveSell,
        vintedNet: Math.round(vintedNet * 100) / 100,
        ebayNet: Math.round(ebayNet * 100) / 100,
        bestNet: Math.round(bestNet * 100) / 100,
        netProfit: Math.round(bestNet * 100) / 100,
        marketData: marketData || null,
        vintedData: vintedData || null
      };
    }).filter(Boolean);

    deals.sort((a, b) => {
      if (a.isAuction && a.hoursLeft < 3) return -1;
      if (b.isAuction && b.hoursLeft < 3) return 1;
      return b.bestNet - a.bestNet;
    });

    console.log(searchTerm + ': ' + deals.length + ' deals | Vinted: ' + (vintedData ? '£' + vintedData.medianPrice + ' median, ' + vintedData.totalListings + ' listings' : 'no data'));
    res.json({ deals });

  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: e.message, deals: [] });
  }
});

app.listen(process.env.PORT || 3000, function() { console.log('FlipRadar proxy running'); });
