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

// ── CONFIG ──
const CLIENT_ID = process.env.EBAY_CLIENT_ID;
const CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const SENDGRID_KEY = process.env.SENDGRID_API_KEY;
const ALERT_EMAIL = process.env.ALERT_EMAIL;
const POSTAGE = 3.50;
const MIN_NET_PROFIT = 15; // Raised from £10 — cuts out marginal deals
const MAX_BUY_PRICE = 10;
const MUST_BUY_RATIO = 0.38; // Stricter — below 38% of market median
const STRONG_RATIO = 0.55;   // Stricter — below 55%

// ── DEFINITIVE SEARCH QUEUE ──
// Built from real Vinted UK 2026 sell-through data and seller ignorance patterns
// Every item here has a proven Vinted buyer audience and realistic profit margin
const QUEUE = [

  // ═══ TIER 1: FASTEST SELLING — Sneakers (47% sell-through, avg 4 days) ═══
  // Trainers are the #1 most liquid category on Vinted. Sellers often don't know value.
  {q:'Nike Air Force 1 trainers',brand:'Nike',avgSell:55,minProfit:15,vintedQ:'Nike Air Force 1',cat:'trainers'},
  {q:'New Balance 990 991 trainers',brand:'New Balance',avgSell:85,minProfit:20,vintedQ:'New Balance 990 991',cat:'trainers'},
  {q:'New Balance 550 trainers',brand:'New Balance',avgSell:70,minProfit:18,vintedQ:'New Balance 550',cat:'trainers'},
  {q:'Adidas Samba trainers',brand:'Adidas',avgSell:65,minProfit:18,vintedQ:'Adidas Samba',cat:'trainers'},
  {q:'Nike Dunk trainers',brand:'Nike',avgSell:75,minProfit:20,vintedQ:'Nike Dunk',cat:'trainers'},
  {q:'Asics Gel Lyte trainers vintage',brand:'Asics',avgSell:60,minProfit:15,vintedQ:'Asics Gel Lyte',cat:'trainers'},

  // ═══ TIER 2: KIDS DESIGNER — Fastest selling clothing (3.8 days avg) ═══
  // Parents sell cheap when kids grow out. Buyers pay full price on Vinted.
  {q:'Stone Island Junior jacket boys',brand:'Stone Island Junior',avgSell:85,minProfit:25,vintedQ:'Stone Island Junior jacket',cat:'kids'},
  {q:'CP Company Junior jacket kids',brand:'CP Company Junior',avgSell:75,minProfit:22,vintedQ:'CP Company Junior jacket',cat:'kids'},
  {q:'Moncler kids jacket boys girls',brand:'Moncler Kids',avgSell:110,minProfit:30,vintedQ:'Moncler kids jacket',cat:'kids'},
  {q:'Burberry kids jacket coat boys',brand:'Burberry Kids',avgSell:60,minProfit:18,vintedQ:'Burberry kids jacket',cat:'kids'},
  {q:'Stone Island kids badge top',brand:'Stone Island Junior',avgSell:45,minProfit:15,vintedQ:'Stone Island Junior top',cat:'kids'},

  // ═══ TIER 3: PREMIUM POLOS — Lacoste and Fred Perry only ═══
  // Ralph Lauren polos REMOVED — too saturated on Vinted, prices match eBay, no real gap
  // Lacoste and Fred Perry have less Vinted supply so prices hold better
  {q:'Lacoste polo shirt mens',brand:'Lacoste',avgSell:32,minProfit:12,vintedQ:'Lacoste polo shirt mens',cat:'polo'},
  {q:'Fred Perry polo shirt mens',brand:'Fred Perry',avgSell:28,minProfit:10,vintedQ:'Fred Perry polo shirt',cat:'polo'},
  {q:'Tommy Hilfiger polo shirt mens',brand:'Tommy Hilfiger',avgSell:28,minProfit:10,vintedQ:'Tommy Hilfiger polo',cat:'polo'},

  // ═══ TIER 4: NIKE VINTAGE — Undisputed #1 brand on Vinted ═══
  // Vintage Nike sweaters/hoodies are most searched items on Vinted 2026
  {q:'Nike vintage hoodie sweatshirt',brand:'Nike',avgSell:42,minProfit:15,vintedQ:'Nike vintage hoodie',cat:'nike'},
  {q:'Nike centre swoosh hoodie vintage',brand:'Nike',avgSell:48,minProfit:18,vintedQ:'Nike centre swoosh hoodie',cat:'nike'},
  {q:'Nike spellout sweatshirt vintage',brand:'Nike',avgSell:45,minProfit:16,vintedQ:'Nike spellout sweatshirt',cat:'nike'},
  {q:'Nike tech fleece jacket',brand:'Nike',avgSell:55,minProfit:18,vintedQ:'Nike tech fleece',cat:'nike'},
  {q:'Nike ACG jacket vintage',brand:'Nike',avgSell:65,minProfit:20,vintedQ:'Nike ACG jacket',cat:'nike'},

  // ═══ TIER 5: OUTERWEAR — High Vinted values, seasonal but worth holding ═══
  // Jackets and coats hold value well. Barbour especially undervalued by eBay sellers.
  {q:'Barbour wax jacket vintage',brand:'Barbour',avgSell:80,minProfit:25,vintedQ:'Barbour wax jacket',cat:'outerwear'},
  {q:'North Face fleece jacket vintage',brand:'North Face',avgSell:55,minProfit:18,vintedQ:'North Face fleece',cat:'outerwear'},
  {q:'Patagonia fleece jacket half zip',brand:'Patagonia',avgSell:65,minProfit:20,vintedQ:'Patagonia fleece',cat:'outerwear'},
  {q:'Arc teryx fleece jacket',brand:"Arc'teryx",avgSell:90,minProfit:28,vintedQ:"Arc'teryx fleece",cat:'outerwear'},
  {q:'Carhartt WIP jacket coat',brand:'Carhartt WIP',avgSell:55,minProfit:18,vintedQ:'Carhartt WIP jacket',cat:'outerwear'},
  {q:'Helly Hansen fleece jacket vintage',brand:'Helly Hansen',avgSell:38,minProfit:12,vintedQ:'Helly Hansen fleece',cat:'outerwear'},

  // ═══ TIER 6: GORPCORE — Outdoor gear holds value better than any clothing ═══
  // Patagonia/Arc'teryx/North Face sellers rarely know real value. Massive Vinted prices.
  {q:'Patagonia down jacket puffer',brand:'Patagonia',avgSell:95,minProfit:30,vintedQ:'Patagonia down jacket',cat:'gorpcore'},
  {q:'Arc teryx Gore-Tex jacket shell',brand:"Arc'teryx",avgSell:120,minProfit:35,vintedQ:"Arc'teryx jacket",cat:'gorpcore'},
  {q:'North Face 700 puffer jacket',brand:'North Face',avgSell:75,minProfit:22,vintedQ:'North Face puffer jacket',cat:'gorpcore'},
  {q:'Patagonia Synchilla fleece vintage',brand:'Patagonia',avgSell:65,minProfit:20,vintedQ:'Patagonia Synchilla fleece',cat:'gorpcore'},

  // ═══ TIER 7: VINTAGE BAND TEES — Single stitch = serious money ═══
  // 90s single stitch band tees bought for £4 sell for £30-60 on Vinted/Depop
  // eBay sellers listing these have zero idea what they're worth
  {q:'vintage band t shirt single stitch 90s',brand:'Vintage Band Tee',avgSell:45,minProfit:15,vintedQ:'vintage band tshirt single stitch',cat:'vintage'},
  {q:'vintage rap tee hip hop shirt 90s',brand:'Vintage Rap Tee',avgSell:55,minProfit:18,vintedQ:'vintage rap tshirt hip hop',cat:'vintage'},
  {q:'Harley Davidson vintage t shirt',brand:'Harley Davidson',avgSell:38,minProfit:12,vintedQ:'Harley Davidson vintage tshirt',cat:'vintage'},
  {q:'vintage rock band tee loft find',brand:'Vintage Band Tee',avgSell:42,minProfit:14,vintedQ:'vintage band tshirt',cat:'vintage'},

  // ═══ TIER 8: ACTIVEWEAR — Growing fast on Vinted, sets especially valuable ═══
  {q:'Lululemon leggings top set',brand:'Lululemon',avgSell:45,minProfit:15,vintedQ:'Lululemon leggings',cat:'activewear'},
  {q:'Gymshark set leggings top',brand:'Gymshark',avgSell:35,minProfit:12,vintedQ:'Gymshark set',cat:'activewear'},
  {q:'Sweaty Betty leggings top',brand:'Sweaty Betty',avgSell:35,minProfit:12,vintedQ:'Sweaty Betty leggings',cat:'activewear'},

  // ═══ TIER 7: VINTAGE DENIM — Levi's 501s are most searched jeans on Vinted ═══
  {q:'Levi 501 jeans vintage',brand:"Levi's",avgSell:45,minProfit:15,vintedQ:"Levi's 501 jeans",cat:'denim'},
  {q:'Levi 501 jeans straight leg',brand:"Levi's",avgSell:42,minProfit:14,vintedQ:"Levi's 501",cat:'denim'},

  // ═══ TIER 8: SELLER IGNORANCE — House clearance/loft finds ═══
  // Untitled vintage items where seller has no idea what they have
  {q:'vintage jacket loft find clearance',brand:'Various',avgSell:40,minProfit:12,vintedQ:'vintage jacket',cat:'vintage'},
  {q:'vintage hoodie sweatshirt old clearance',brand:'Various',avgSell:35,minProfit:10,vintedQ:'vintage hoodie',cat:'vintage'},
  {q:'vintage retro ski jacket colourful',brand:'Various',avgSell:55,minProfit:18,vintedQ:'vintage ski jacket',cat:'vintage'},
  {q:'Moschino vintage top jacket',brand:'Moschino',avgSell:60,minProfit:18,vintedQ:'Moschino vintage',cat:'vintage'},
  {q:'Versace jeans couture vintage',brand:'Versace Jeans',avgSell:65,minProfit:20,vintedQ:'Versace Jeans Couture',cat:'vintage'},
  {q:'Armani Exchange vintage jacket',brand:'Armani',avgSell:45,minProfit:15,vintedQ:'Armani Exchange vintage',cat:'vintage'},

  // ═══ TIER 9: FOOTBALL SHIRTS — Collector market, seller ignorance very high ═══
  {q:'Parma Fiorentina Sampdoria football shirt',brand:'Serie A',avgSell:65,minProfit:20,vintedQ:'Serie A vintage football shirt',cat:'football'},
  {q:'USSR Yugoslavia Eastern European football shirt',brand:'Eastern Europe',avgSell:65,minProfit:20,vintedQ:'vintage football shirt',cat:'football'},
  {q:'football shirt loft find old rare bundle',brand:'Football',avgSell:50,minProfit:15,vintedQ:'vintage football shirt',cat:'football'},
  {q:'Wimbledon Coventry Bradford City shirt',brand:'UK Lower League',avgSell:45,minProfit:14,vintedQ:'lower league football shirt',cat:'football'},

  // ═══ TIER 10: MISSPELLINGS — Zero competition, genuine bargains ═══
  {q:'Addidas hoodie vintage',brand:'Adidas',avgSell:35,minProfit:12,vintedQ:'Adidas hoodie',cat:'typo'},
  {q:'Niike hoodie vintage',brand:'Nike',avgSell:42,minProfit:15,vintedQ:'Nike hoodie',cat:'typo'},
  {q:'Patogonia fleece jacket',brand:'Patagonia',avgSell:65,minProfit:20,vintedQ:'Patagonia fleece',cat:'typo'},
  {q:'Barbour wax jakcet',brand:'Barbour',avgSell:80,minProfit:25,vintedQ:'Barbour wax jacket',cat:'typo'},
  {q:'Stone Ilsand junior jacket',brand:'Stone Island Junior',avgSell:85,minProfit:25,vintedQ:'Stone Island Junior',cat:'typo'},
  {q:'Luluelmon leggings',brand:'Lululemon',avgSell:45,minProfit:15,vintedQ:'Lululemon leggings',cat:'typo'},
  {q:'Freddy Perry polo shirt',brand:'Fred Perry',avgSell:28,minProfit:10,vintedQ:'Fred Perry polo',cat:'typo'},
  {q:'Lacoste polo shitr',brand:'Lacoste',avgSell:32,minProfit:12,vintedQ:'Lacoste polo',cat:'typo'},
  {q:'New Ballance trainers',brand:'New Balance',avgSell:85,minProfit:20,vintedQ:'New Balance trainers',cat:'typo'},
];

// ── REAL VINTED PRICE RANGES (from manual research March 2026) ──
// Used to cross-check AI estimates and score confidence
const VINTED_RANGES = {
  'Nike Air Force 1': {low:25,high:65,avg:40},
  'New Balance 990': {low:45,high:120,avg:75},
  'New Balance 550': {low:35,high:80,avg:55},
  'Adidas Samba': {low:30,high:70,avg:48},
  'Nike Dunk': {low:35,high:90,avg:58},
  'Stone Island Junior': {low:45,high:160,avg:85},
  'CP Company Junior': {low:40,high:120,avg:70},
  'Moncler Kids': {low:65,high:200,avg:110},
  'Ralph Lauren polo': {low:12,high:35,avg:22},
  'Lacoste polo': {low:14,high:38,avg:25},
  'Fred Perry polo': {low:12,high:30,avg:20},
  'Tommy Hilfiger polo': {low:12,high:32,avg:22},
  'Nike hoodie': {low:18,high:55,avg:35},
  'Barbour wax jacket': {low:35,high:120,avg:70},
  'North Face fleece': {low:25,high:70,avg:45},
  'Patagonia fleece': {low:30,high:85,avg:55},
  "Arc'teryx": {low:45,high:180,avg:90},
  'Lululemon': {low:18,high:60,avg:38},
  'Gymshark': {low:12,high:40,avg:25},
  "Levi's 501": {low:18,high:55,avg:35},
};

// Items to always reject — these waste scan time and have no margin
const HARD_REJECT = [
  'reproduction','replica','remake','bootleg','badge','pin','pennant',
  'programme','program','scarf','poster','mug','sticker','patch',
  'keyring','book','magazine','dvd','photo','trading card','ticket',
  'figurine','dirty','heavily worn','major stain','ripped','torn',
  'broken zip','bundle of badges','job lot badges'
];

const COND_WARN = [
  'stain','mark','faded','damage','repair','hole','smell','fault',
  'as seen','as is','worn','well worn','tatty','grubby','needs clean'
];

let cachedToken = null;
let tokenExpiry = 0;
const alertedIds = new Set();

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
  if (item.itemLocation?.country && item.itemLocation.country !== 'GB') return true;
  return HARD_REJECT.some(w => text.includes(w));
}

// Get real eBay UK market prices — 40 listings, outliers removed
async function getMarketPrices(query, token) {
  try {
    const q = encodeURIComponent(query);
    const url = 'https://api.ebay.com/buy/browse/v1/item_summary/search?q=' + q +
      '&limit=40&marketplace_ids=EBAY_GB' +
      '&filter=itemLocationCountry:GB,buyingOptions:{FIXED_PRICE}' +
      '&sort=endDateSoonest';
    const r = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + token, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_GB' },
      signal: AbortSignal.timeout(10000)
    });
    const data = await r.json();
    const items = (data.itemSummaries || []).filter(i => !shouldReject(i));
    if (!items.length) return null;

    const prices = items.map(i => parseFloat(i.price?.value || 0)).filter(p => p > 2).sort((a, b) => a - b);
    if (prices.length < 5) return null;

    const trimmed = prices.slice(Math.floor(prices.length * 0.25), Math.ceil(prices.length * 0.75));
    if (!trimmed.length) return null;

    const median = trimmed[Math.floor(trimmed.length / 2)];
    return {
      median: Math.round(median * 100) / 100,
      low: trimmed[0],
      high: trimmed[trimmed.length - 1],
      sampleSize: prices.length,
      trimmedSize: trimmed.length
    };
  } catch (e) { return null; }
}

// Get REAL Vinted UK prices via Apify Vinted Smart Scraper (kazkn)
const APIFY_KEY = process.env.APIFY_API_KEY;
const vintedPriceCache = new Map();

async function getRealVintedPrices(query) {
  if (!APIFY_KEY) return null;

  const cacheKey = query.toLowerCase().trim();
  const cached = vintedPriceCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 30 * 60 * 1000) return cached.data;

  try {
    const res = await fetch(
      'https://api.apify.com/v2/acts/kazkn~vinted-smart-scraper/run-sync-get-dataset-items?token=' + APIFY_KEY + '&timeout=60&memory=256',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'SEARCH',
          query: query,
          countries: ['uk'],
          maxItems: 30,
          sortBy: 'relevance',
          includePhotos: false,
          includeSellerDetails: false
        }),
        signal: AbortSignal.timeout(65000)
      }
    );

    if (!res.ok) {
      console.log('Apify error ' + res.status + ' for "' + query + '"');
      return null;
    }

    const items = await res.json();
    if (!Array.isArray(items) || items.length < 3) {
      console.log('Apify: insufficient results for "' + query + '" (' + (items?.length || 0) + ')');
      return null;
    }

    const prices = items
      .map(i => {
        const p = i.price || i.priceNumeric || i.price_numeric || 0;
        return typeof p === 'string' ? parseFloat(p.replace(/[^0-9.]/g, '')) : parseFloat(p);
      })
      .filter(p => p > 1 && p < 200)
      .sort((a, b) => a - b);

    if (prices.length < 3) return null;

    const trimmed = prices.slice(Math.floor(prices.length * 0.2), Math.ceil(prices.length * 0.8));
    const median = trimmed[Math.floor(trimmed.length / 2)];
    const avg = Math.round(trimmed.reduce((a, b) => a + b, 0) / trimmed.length);

    const result = {
      median: Math.round(median * 100) / 100,
      avg,
      low: trimmed[0],
      high: trimmed[trimmed.length - 1],
      sampleSize: prices.length,
      isReal: true
    };

    vintedPriceCache.set(cacheKey, { data: result, ts: Date.now() });
    console.log('Apify Vinted "' + query + '": median £' + result.median + ' (' + result.sampleSize + ' listings)');
    return result;

  } catch (e) {
    console.log('Apify timeout/error for "' + query + '":', e.message);
    return null;
  }
}

// Get Vinted price range from our manual research data (fallback)
function getVintedRange(brand) {
  for (const [key, range] of Object.entries(VINTED_RANGES)) {
    if (brand && brand.toLowerCase().includes(key.toLowerCase())) return range;
  }
  return null;
}

// Score a deal with all available data including real Vinted prices
function scoreDeal(item, marketData, queueItem, realVintedData) {
  const price = parseFloat(item.price?.value || item.price || 0);
  if (price <= 0 || price > MAX_BUY_PRICE) return null;

  const title = item.title || '';
  const titleLower = title.toLowerCase();
  const hasCondWarn = COND_WARN.some(w => titleLower.includes(w));

  // Condition signals
  const isExcellent = titleLower.includes('bnwt') || titleLower.includes('unworn') ||
    titleLower.includes('never worn') || titleLower.includes('new with tags') ||
    titleLower.includes('immaculate') || titleLower.includes('mint');

  // ── VINTED PRICE: Use real Apify data if available, fall back to manual ranges ──
  let vintedSellPrice, vintedDataSource, vintedRange;

  if (realVintedData && realVintedData.isReal && realVintedData.sampleSize >= 5) {
    // REAL Vinted data from Apify — use median as list price
    vintedSellPrice = realVintedData.median;
    if (isExcellent) vintedSellPrice = Math.round(vintedSellPrice * 1.15);
    if (hasCondWarn) vintedSellPrice = Math.round(vintedSellPrice * 0.80);
    vintedDataSource = 'real';
    vintedRange = realVintedData;
  } else {
    // Fall back to manual research ranges
    vintedRange = getVintedRange(queueItem.brand);
    if (vintedRange) {
      vintedSellPrice = Math.round(vintedRange.low + (vintedRange.avg - vintedRange.low) * 0.3);
    } else {
      vintedSellPrice = queueItem.avgSell;
    }
    if (isExcellent) vintedSellPrice = Math.round(vintedSellPrice * 1.2);
    if (hasCondWarn) vintedSellPrice = Math.round(vintedSellPrice * 0.75);
    vintedDataSource = 'estimated';
  }

  const vintedNet = vintedSellPrice - price - POSTAGE;
  const itemMinProfit = queueItem.minProfit || MIN_NET_PROFIT;
  if (vintedNet < itemMinProfit) return null;

  // ── CONFIDENCE TIER ──
  let confidenceTier = 'possible';
  let confidenceReasons = [];
  let confidenceScore = 0;

  const hasRealVinted = vintedDataSource === 'real';
  const hasMarketData = marketData && marketData.sampleSize >= 5;

  if (hasRealVinted && hasMarketData) {
    // Best case: both real Vinted prices AND real eBay market data
    const ratio = price / marketData.median;
    if (ratio <= MUST_BUY_RATIO && !hasCondWarn && vintedNet >= 15) {
      confidenceTier = 'mustbuy';
      confidenceScore = 98;
      confidenceReasons.push('✅ REAL Vinted UK prices: ' + realVintedData.sampleSize + ' live listings · Median £' + realVintedData.median + ' · Range £' + realVintedData.low + '–£' + realVintedData.high);
      confidenceReasons.push('✅ Priced at ' + Math.round(ratio * 100) + '% of eBay market median (£' + marketData.median + ') — ' + marketData.sampleSize + ' listings');
    } else if (ratio <= STRONG_RATIO && vintedNet >= itemMinProfit) {
      confidenceTier = 'strong';
      confidenceScore = 82;
      confidenceReasons.push('✅ REAL Vinted prices: median £' + realVintedData.median + ' (' + realVintedData.sampleSize + ' listings)');
      confidenceReasons.push('eBay market median £' + marketData.median + ' · This item at ' + Math.round(ratio * 100) + '%');
    } else {
      confidenceTier = 'possible';
      confidenceScore = 55;
      confidenceReasons.push('Real Vinted data: median £' + realVintedData.median + ' — margin tighter than ideal');
    }
  } else if (hasRealVinted && !hasMarketData) {
    // Real Vinted data but no eBay market data
    if (!hasCondWarn && vintedNet >= 15) {
      confidenceTier = 'strong';
      confidenceScore = 75;
      confidenceReasons.push('✅ REAL Vinted UK prices: ' + realVintedData.sampleSize + ' listings · Median £' + realVintedData.median);
      confidenceReasons.push('No eBay market comparison available for this search');
    } else {
      confidenceTier = 'possible';
      confidenceScore = 50;
      confidenceReasons.push('Real Vinted data available but verify before buying');
    }
  } else if (!hasRealVinted && hasMarketData) {
    // eBay market data only — no real Vinted prices
    const ratio = price / marketData.median;
    if (ratio <= MUST_BUY_RATIO && !hasCondWarn && vintedNet >= 15) {
      confidenceTier = 'strong'; // Downgrade to strong without real Vinted confirmation
      confidenceScore = 70;
      confidenceReasons.push('eBay: priced at ' + Math.round(ratio * 100) + '% of market median (£' + marketData.median + ')');
      confidenceReasons.push('⚠ Vinted price estimated — do 60 second check before buying');
    } else if (ratio <= STRONG_RATIO && vintedNet >= itemMinProfit) {
      confidenceTier = 'possible';
      confidenceScore = 45;
      confidenceReasons.push('eBay market data available but Vinted price not confirmed');
    } else {
      return null;
    }
  } else {
    // No real data at all — only show high-margin estimated deals
    if (vintedNet >= 20 && !hasCondWarn) {
      confidenceTier = 'possible';
      confidenceScore = 30;
      confidenceReasons.push('⚠ Estimated pricing only — verify on Vinted before buying');
    } else {
      return null;
    }
  }

  // Boosts
  if (isExcellent) { confidenceScore = Math.min(99, confidenceScore + 8); confidenceReasons.push('Excellent condition — commands higher Vinted price'); }
  if (queueItem.cat === 'typo') { confidenceScore = Math.min(99, confidenceScore + 5); confidenceReasons.push('Misspelled title — zero competition from other buyers'); }
  if (titleLower.includes('loft find') || titleLower.includes('house clearance')) { confidenceScore = Math.min(99, confidenceScore + 5); confidenceReasons.push('Seller likely unaware of value'); }

  const roi = Math.round((vintedNet / price) * 100);
  const vintedTitle = generateVintedTitle(title, queueItem.brand, queueItem.cat);

  return {
    id: item.itemId || item.id,
    title,
    price,
    url: item.itemWebUrl || item.url,
    image: item.image?.imageUrl || item.image,
    condition: item.condition,
    brand: queueItem.brand,
    cat: queueItem.cat,
    vintedListPrice: vintedSellPrice,
    vintedNet: Math.round(vintedNet * 100) / 100,
    roi,
    confidenceTier,
    confidenceScore,
    confidenceReasons,
    marketData,
    vintedRange,
    realVintedData: realVintedData || null,
    vintedDataSource,
    hasCondWarn,
    isExcellent,
    vintedTitle,
    endDate: item.itemEndDate || null,
    isAuction: item.buyingOptions ? item.buyingOptions.includes('AUCTION') : false,
    source: item.source || 'eBay'
  };
}

function generateVintedTitle(originalTitle, brand, cat) {
  const condition = originalTitle.toLowerCase().includes('bnwt') ? 'BNWT' :
    originalTitle.toLowerCase().includes('unworn') ? 'Unworn' : '';
  const size = (originalTitle.match(/\b(XS|S|M|L|XL|XXL|size \d+|uk\d+|\d+ years)\b/i) || [])[0] || '';

  if (cat === 'trainers') return (brand + ' ' + originalTitle.replace(brand, '').replace(/[^\w\s]/g, '').trim() + ' ' + size).substring(0, 60).trim();
  if (cat === 'kids') return (brand + ' Kids Jacket ' + size + (condition ? ' ' + condition : '')).trim();
  if (cat === 'polo') return (brand + ' Polo Shirt ' + size + (condition ? ' ' + condition : '') + ' Vintage').trim();
  if (cat === 'nike') return ('Vintage ' + brand + ' Hoodie Sweatshirt ' + size + ' ' + (condition || 'Old School')).trim();
  return (brand + ' ' + cat + ' ' + size + (condition ? ' ' + condition : '') + ' Vintage').trim().substring(0, 60);
}

// Build rich HTML email
function buildEmailHtml(deals) {
  const mustBuys = deals.filter(d => d.confidenceTier === 'mustbuy');
  const strong = deals.filter(d => d.confidenceTier === 'strong');
  const possible = deals.filter(d => d.confidenceTier === 'possible');

  const tierColor = t => t === 'mustbuy' ? '#16a34a' : t === 'strong' ? '#2563eb' : '#d97706';
  const tierLabel = t => t === 'mustbuy' ? '🎯 MUST BUY' : t === 'strong' ? '⚡ STRONG' : '✓ POSSIBLE';
  const tierDesc = t => t === 'mustbuy'
    ? 'Real eBay data confirms this is priced well below market. Act quickly.'
    : t === 'strong'
    ? 'Good profit likely — quick Vinted check recommended before buying.'
    : 'Estimated profit — always verify on Vinted before purchasing.';

  const dealHtml = deals.map(d => `
    <div style="border:2px solid ${tierColor(d.confidenceTier)};border-radius:10px;padding:16px;margin-bottom:16px;font-family:sans-serif;background:#fff;">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:${tierColor(d.confidenceTier)};margin-bottom:4px;">${tierLabel(d.confidenceTier)}</div>
      <div style="font-size:10px;color:#666;margin-bottom:8px;">${tierDesc(d.confidenceTier)}</div>
      <div style="font-size:16px;font-weight:700;margin-bottom:10px;line-height:1.3;">${d.title}</div>
      <div style="display:flex;gap:16px;margin-bottom:10px;flex-wrap:wrap;">
        <div style="text-align:center;padding:8px 12px;background:#f5f5f5;border-radius:6px;">
          <div style="font-size:10px;color:#888;text-transform:uppercase;margin-bottom:2px;">Buy for</div>
          <div style="font-size:20px;font-weight:700;">£${d.price}</div>
        </div>
        <div style="text-align:center;padding:8px 12px;background:#f5f5f5;border-radius:6px;">
          <div style="font-size:10px;color:#888;text-transform:uppercase;margin-bottom:2px;">List on Vinted</div>
          <div style="font-size:20px;font-weight:700;color:#0891b2;">£${d.vintedListPrice}</div>
          ${d.vintedRange ? `<div style="font-size:9px;color:#888;">Range £${d.vintedRange.low}–£${d.vintedRange.high}</div>` : ''}
        </div>
        <div style="text-align:center;padding:8px 12px;background:#f0fdf4;border-radius:6px;border:1px solid #bbf7d0;">
          <div style="font-size:10px;color:#888;text-transform:uppercase;margin-bottom:2px;">Net profit</div>
          <div style="font-size:20px;font-weight:700;color:#16a34a;">+£${d.vintedNet}</div>
          <div style="font-size:9px;color:#888;">after £${POSTAGE} postage</div>
        </div>
        <div style="text-align:center;padding:8px 12px;background:#f5f5f5;border-radius:6px;">
          <div style="font-size:10px;color:#888;text-transform:uppercase;margin-bottom:2px;">ROI</div>
          <div style="font-size:20px;font-weight:700;">${d.roi}%</div>
        </div>
      </div>
      ${d.realVintedData && d.realVintedData.isReal ? `
      <div style="background:#f0fdf4;border:2px solid #16a34a;border-radius:6px;padding:10px 12px;margin-bottom:8px;font-size:11px;">
        <div style="font-weight:700;color:#16a34a;margin-bottom:4px;">✅ REAL VINTED UK PRICES — Live data from Vinted right now</div>
        <div style="font-family:monospace;color:#166534;">${d.realVintedData.sampleSize} current listings · Median £${d.realVintedData.median} · Range £${d.realVintedData.low}–£${d.realVintedData.high} · Avg £${d.realVintedData.avg}</div>
        <div style="color:#166534;margin-top:3px;">Your list price of £${d.vintedListPrice} is based on real current Vinted data — not an estimate.</div>
      </div>` : `
      <div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:6px;padding:8px 12px;margin-bottom:8px;font-size:11px;">
        <div style="color:#92400e;">⚠ Vinted price estimated — do a quick Vinted search before buying to confirm</div>
      </div>`}
      ${d.marketData ? `
      <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;padding:8px 12px;margin-bottom:8px;font-size:11px;font-family:monospace;">
        📊 eBay UK market: ${d.marketData.sampleSize} listings · Median £${d.marketData.median} · Range £${d.marketData.low}–£${d.marketData.high}
      </div>` : ''}
      <div style="margin-bottom:10px;">
        ${d.confidenceReasons.map(r => `<div style="font-size:11px;color:#444;margin-bottom:2px;">✓ ${r}</div>`).join('')}
        ${d.hasCondWarn ? '<div style="font-size:11px;color:#dc2626;margin-bottom:2px;">⚠ Condition flag in title — check listing carefully before buying</div>' : ''}
        ${d.isExcellent ? '<div style="font-size:11px;color:#16a34a;margin-bottom:2px;">⭐ Excellent condition signals — commands higher Vinted price</div>' : ''}
      </div>
      ${d.vintedTitle ? `
      <div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:6px;padding:8px 12px;margin-bottom:10px;">
        <div style="font-size:9px;text-transform:uppercase;color:#888;margin-bottom:3px;">Suggested Vinted listing title</div>
        <div style="font-size:12px;font-weight:600;">${d.vintedTitle}</div>
      </div>
      <div style="background:#fefce8;border:1px solid #fde047;border-radius:6px;padding:8px 12px;margin-bottom:10px;">
        <div style="font-size:9px;text-transform:uppercase;color:#888;margin-bottom:3px;">60 second Vinted check — search this before buying</div>
        <div style="font-size:12px;font-weight:700;color:#854d0e;">"${d.vintedTitle}"</div>
        <div style="font-size:10px;color:#666;margin-top:3px;">You should see similar items listed at around £${Math.round(d.vintedListPrice * 0.85)}–£${Math.round(d.vintedListPrice * 1.2)}. If you do — buy it. If everything is listed at £${Math.round(d.vintedListPrice * 0.5)} or less — skip it.</div>
      </div>` : ''}
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <a href="${d.url}" style="background:#111;color:white;padding:8px 14px;border-radius:6px;text-decoration:none;font-size:12px;font-weight:600;">View on eBay →</a>
        <a href="https://www.vinted.co.uk/catalog?search_text=${encodeURIComponent(d.vintedTitle || d.brand)}&order=relevance&currency=GBP" style="background:#0891b2;color:white;padding:8px 14px;border-radius:6px;text-decoration:none;font-size:12px;font-weight:600;">Check Vinted</a>
        <a href="https://www.ebay.co.uk/sch/i.html?_nkw=${encodeURIComponent(d.vintedTitle || d.title)}&LH_Complete=1&LH_Sold=1" style="background:#d97706;color:white;padding:8px 14px;border-radius:6px;text-decoration:none;font-size:12px;font-weight:600;">eBay Sold</a>
      </div>
    </div>
  `).join('');

  return `
    <div style="max-width:620px;margin:0 auto;font-family:sans-serif;background:#f7f7f5;padding:16px;">
      <div style="background:#111;color:white;padding:16px 20px;border-radius:10px;margin-bottom:16px;">
        <div style="font-size:18px;font-weight:700;margin-bottom:4px;">● FlipRadar Alert</div>
        <div style="font-size:12px;color:rgba(255,255,255,0.6);">${new Date().toLocaleString('en-GB')} · ${mustBuys.length} Must Buy · ${strong.length} Strong · ${possible.length} Possible</div>
      </div>
      ${mustBuys.length > 0 ? `<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:12px;margin-bottom:12px;font-size:12px;color:#166534;">🎯 <strong>Must Buy deals now use REAL live Vinted prices fetched automatically — not estimates.</strong> These are the ones to act on quickly.</div>` : ''}
      ${dealHtml}
      <div style="text-align:center;font-size:10px;color:#999;margin-top:16px;padding:12px;border-top:1px solid #e5e5e0;">
        FlipRadar UK · Profit = sell price − buy price − £${POSTAGE} postage · Vinted has no seller fees<br>
        Conservative pricing used — actual Vinted prices may be higher · Always verify before buying
      </div>
    </div>
  `;
}

async function sendAlert(deals) {
  if (!SENDGRID_KEY || !ALERT_EMAIL) {
    console.log('No email config — skipping alert');
    return;
  }
  const mustBuys = deals.filter(d => d.confidenceTier === 'mustbuy');
  const strong = deals.filter(d => d.confidenceTier === 'strong');
  const subject = mustBuys.length > 0
    ? `🎯 ${mustBuys.length} Must Buy deal${mustBuys.length > 1 ? 's' : ''} found — FlipRadar`
    : `⚡ ${strong.length} Strong deal${strong.length > 1 ? 's' : ''} — FlipRadar`;

  try {
    const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + SENDGRID_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: ALERT_EMAIL }] }],
        from: { email: ALERT_EMAIL, name: 'FlipRadar' },
        subject,
        content: [{ type: 'text/html', value: buildEmailHtml(deals) }]
      })
    });
    if (r.ok) {
      console.log('Alert sent: ' + subject);
    } else {
      const err = await r.text();
      console.error('SendGrid error:', err);
    }
  } catch (e) {
    console.error('Email failed:', e.message);
  }
}

// ── MAIN SCAN FUNCTION ──
async function runScan() {
  const hour = new Date().getHours();
  if (hour >= 0 && hour < 7) {
    console.log('Night mode — paused until 7am');
    return;
  }

  console.log('Scan started at ' + new Date().toLocaleString('en-GB'));
  let token;
  try { token = await getToken(); } catch (e) { console.error('Token error:', e.message); return; }

  const alertDeals = [];

  for (const qItem of QUEUE) {
    try {
      const q = encodeURIComponent(qItem.q);

      // Fetch eBay listings and eBay market data in parallel
      const [ebayRes, marketData] = await Promise.all([
        fetch('https://api.ebay.com/buy/browse/v1/item_summary/search?q=' + q +
          '&limit=20&marketplace_ids=EBAY_GB' +
          '&filter=price:[0..' + MAX_BUY_PRICE + '],priceCurrency:GBP,itemLocationCountry:GB' +
          '&sort=newlyListed', {
          headers: { 'Authorization': 'Bearer ' + token, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_GB' },
          signal: AbortSignal.timeout(12000)
        }),
        getMarketPrices(qItem.vintedQ || qItem.q, token)
      ]);

      const ebayData = await ebayRes.json();
      const listings = (ebayData.itemSummaries || [])
        .filter(l => !shouldReject(l))
        .slice(0, 12);

      if (!listings.length) continue;

      // Fetch real Vinted prices via Apify — one call per search term, cached 30 mins
      const realVintedData = await getRealVintedPrices(qItem.vintedQ || qItem.q);

      for (const listing of listings) {
        const id = listing.itemId;
        if (alertedIds.has(id)) continue;

        const deal = scoreDeal(listing, marketData, qItem, realVintedData);
        if (!deal) continue;

        if (deal.confidenceTier === 'mustbuy' || deal.confidenceTier === 'strong') {
          alertDeals.push(deal);
          alertedIds.add(id);
          const vintedSrc = realVintedData ? '(REAL Vinted)' : '(estimated)';
          console.log('[' + deal.confidenceTier.toUpperCase() + '] ' + deal.title.substring(0, 55) + ' — Buy £' + deal.price + ' → Vinted £' + deal.vintedListPrice + ' ' + vintedSrc + ' (+£' + deal.vintedNet + ')');
        }
      }

      await new Promise(r => setTimeout(r, 700));
    } catch (e) {
      console.error('Error scanning "' + qItem.q + '":', e.message);
    }
  }

  const mustBuyCount = alertDeals.filter(d => d.confidenceTier === 'mustbuy').length;
  console.log('Scan complete — ' + alertDeals.length + ' deals (' + mustBuyCount + ' Must Buy)');

  if (alertDeals.length > 0) {
    // Only email Must Buy — Strong deals are discarded to reduce noise
    const mustBuysOnly = alertDeals.filter(d => d.confidenceTier === 'mustbuy');
    if (mustBuysOnly.length > 0) {
      mustBuysOnly.sort((a, b) => b.confidenceScore - a.confidenceScore);
      await sendAlert(mustBuysOnly.slice(0, 5)); // Max 5 per email
    } else {
      console.log('No Must Buy deals this scan — skipping email');
    }
  }

  if (alertedIds.size > 800) alertedIds.clear();
}

// ── SCHEDULE: Every 4 hours ──
async function scheduledScan() {
  await runScan();
  setTimeout(scheduledScan, 4 * 60 * 60 * 1000);
}

// ── ENDPOINTS ──
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    botRunning: true,
    alertEmail: ALERT_EMAIL || 'not set',
    emailReady: !!SENDGRID_KEY,
    maxBuyPrice: MAX_BUY_PRICE,
    queueSize: QUEUE.length,
    alertedSoFar: alertedIds.size
  });
});

app.get('/scan', (req, res) => {
  res.json({ message: 'Scan started — check logs and your email in ~5 minutes' });
  runScan();
});

// Web app deals endpoint
app.get('/deals', async (req, res) => {
  try {
    const token = await getToken();
    const searchTerm = req.query.q || '';
    const brand = req.query.brand || '';
    const cat = req.query.cat || 'vintage';
    const avgSell = parseFloat(req.query.avgSell || '40');
    const max = req.query.maxPrice || String(MAX_BUY_PRICE);
    const min = req.query.minPrice || '0';
    const q = encodeURIComponent(searchTerm);

    // Find matching queue item for context
    const qItem = QUEUE.find(i => i.brand === brand) || {
      brand, cat, avgSell, minProfit: MIN_NET_PROFIT, vintedQ: searchTerm, q: searchTerm
    };

    const [ebayRes, marketData] = await Promise.all([
      fetch('https://api.ebay.com/buy/browse/v1/item_summary/search?q=' + q +
        '&limit=15&marketplace_ids=EBAY_GB' +
        '&filter=price:[' + min + '..' + max + '],priceCurrency:GBP,itemLocationCountry:GB' +
        '&sort=newlyListed', {
        headers: { 'Authorization': 'Bearer ' + token, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_GB' }
      }),
      getMarketPrices(req.query.vintedQ || searchTerm, token)
    ]);

    const ebayData = await ebayRes.json();
    const items = (ebayData.itemSummaries || []).filter(l => !shouldReject(l)).slice(0, 10);

    const deals = items.map(listing => {
      const deal = scoreDeal(listing, marketData, qItem);
      return deal;
    }).filter(Boolean);

    deals.sort((a, b) => {
      if (a.confidenceTier === 'mustbuy' && b.confidenceTier !== 'mustbuy') return -1;
      if (b.confidenceTier === 'mustbuy' && a.confidenceTier !== 'mustbuy') return 1;
      return b.vintedNet - a.vintedNet;
    });

    res.json({ deals });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: e.message, deals: [] });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log('FlipRadar bot running');
  console.log('Alert email: ' + (ALERT_EMAIL || 'NOT SET'));
  console.log('Email service: ' + (SENDGRID_KEY ? 'SendGrid ready' : 'NOT SET'));
  console.log('Queue: ' + QUEUE.length + ' searches');
  console.log('Max buy price: £' + MAX_BUY_PRICE);
  setTimeout(scheduledScan, 30000);
});
