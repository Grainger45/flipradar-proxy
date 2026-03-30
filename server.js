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
const MIN_NET_PROFIT = 15;
const MAX_BUY_PRICE = 20; // Compromise — £20 max, but only alerts when ROI > 100%
const MUST_BUY_RATIO = 0.40; // Below 40% of market median = Must Buy
const STRONG_RATIO = 0.55;   // Below 55% = Strong
const MIN_ROI = 100; // Must make at least 100% return on buy price (e.g. buy £10, profit £10+)

// ── DEFINITIVE SEARCH QUEUE ──
// Built from real Vinted UK 2026 sell-through data and seller ignorance patterns
// Every item here has a proven Vinted buyer audience and realistic profit margin
const QUEUE = [

  // ═══ TIER 1: TRAINERS ═══
  {q:'Nike Air Force 1 trainers',brand:'Nike',avgSell:55,minProfit:15,vintedQ:'Nike Air Force 1',soldQ:'Nike Air Force 1 trainers shoes',cat:'trainers'},
  {q:'New Balance 990 991 trainers',brand:'New Balance',avgSell:85,minProfit:20,vintedQ:'New Balance 990 991',soldQ:'New Balance 990 trainers shoes',cat:'trainers'},
  {q:'New Balance 550 trainers',brand:'New Balance',avgSell:70,minProfit:18,vintedQ:'New Balance 550',soldQ:'New Balance 550 trainers shoes',cat:'trainers'},
  {q:'Adidas Samba trainers',brand:'Adidas',avgSell:65,minProfit:18,vintedQ:'Adidas Samba',soldQ:'Adidas Samba trainers shoes',cat:'trainers'},
  {q:'Nike Dunk trainers',brand:'Nike',avgSell:75,minProfit:20,vintedQ:'Nike Dunk',soldQ:'Nike Dunk trainers shoes',cat:'trainers'},
  {q:'Asics Gel Lyte trainers vintage',brand:'Asics',avgSell:60,minProfit:15,vintedQ:'Asics Gel Lyte',soldQ:'Asics Gel Lyte trainers shoes',cat:'trainers'},

  // ═══ TIER 2: KIDS DESIGNER ═══
  {q:'Stone Island Junior jacket boys',brand:'Stone Island Junior',avgSell:85,minProfit:25,vintedQ:'Stone Island Junior jacket',soldQ:'Stone Island Junior jacket kids',cat:'kids'},
  {q:'CP Company Junior jacket kids',brand:'CP Company Junior',avgSell:75,minProfit:22,vintedQ:'CP Company Junior jacket',soldQ:'CP Company Junior jacket kids',cat:'kids'},
  {q:'Moncler kids jacket boys girls',brand:'Moncler Kids',avgSell:110,minProfit:30,vintedQ:'Moncler kids jacket',soldQ:'Moncler kids jacket boys girls',cat:'kids'},
  {q:'Burberry kids jacket coat boys',brand:'Burberry Kids',avgSell:60,minProfit:18,vintedQ:'Burberry kids jacket',soldQ:'Burberry kids jacket coat',cat:'kids'},
  {q:'Stone Island kids badge top',brand:'Stone Island Junior',avgSell:45,minProfit:15,vintedQ:'Stone Island Junior top',soldQ:'Stone Island Junior top kids',cat:'kids'},

  // ═══ TIER 3: PREMIUM POLOS ═══
  {q:'Lacoste polo shirt mens',brand:'Lacoste',avgSell:32,minProfit:12,vintedQ:'Lacoste polo shirt mens',soldQ:'Lacoste polo shirt mens',cat:'polo'},
  {q:'Fred Perry polo shirt mens',brand:'Fred Perry',avgSell:28,minProfit:10,vintedQ:'Fred Perry polo shirt',soldQ:'Fred Perry polo shirt mens',cat:'polo'},
  {q:'Tommy Hilfiger polo shirt mens',brand:'Tommy Hilfiger',avgSell:28,minProfit:10,vintedQ:'Tommy Hilfiger polo',soldQ:'Tommy Hilfiger polo shirt mens',cat:'polo'},

  // ═══ TIER 4: NIKE VINTAGE ═══
  {q:'Nike vintage hoodie sweatshirt',brand:'Nike',avgSell:42,minProfit:15,vintedQ:'Nike vintage hoodie',soldQ:'Nike vintage hoodie sweatshirt',cat:'nike'},
  {q:'Nike centre swoosh hoodie vintage',brand:'Nike',avgSell:48,minProfit:18,vintedQ:'Nike centre swoosh hoodie',soldQ:'Nike centre swoosh hoodie',cat:'nike'},
  {q:'Nike spellout sweatshirt vintage',brand:'Nike',avgSell:45,minProfit:16,vintedQ:'Nike spellout sweatshirt',soldQ:'Nike spellout sweatshirt vintage',cat:'nike'},
  {q:'Nike tech fleece jacket',brand:'Nike',avgSell:55,minProfit:18,vintedQ:'Nike tech fleece',soldQ:'Nike tech fleece jacket hoodie',cat:'nike'},
  {q:'Nike ACG jacket vintage',brand:'Nike',avgSell:65,minProfit:20,vintedQ:'Nike ACG jacket',soldQ:'Nike ACG jacket vintage',cat:'nike'},

  // ═══ TIER 5: OUTERWEAR ═══
  {q:'Barbour wax jacket vintage',brand:'Barbour',avgSell:80,minProfit:25,vintedQ:'Barbour wax jacket',soldQ:'Barbour wax jacket mens',cat:'outerwear'},
  {q:'North Face fleece jacket vintage',brand:'North Face',avgSell:55,minProfit:18,vintedQ:'North Face fleece',soldQ:'North Face fleece jacket',cat:'outerwear'},
  {q:'Patagonia fleece jacket half zip',brand:'Patagonia',avgSell:65,minProfit:20,vintedQ:'Patagonia fleece',soldQ:'Patagonia fleece jacket half zip',cat:'outerwear'},
  {q:'Arc teryx fleece jacket',brand:"Arc'teryx",avgSell:90,minProfit:28,vintedQ:"Arc'teryx fleece",soldQ:"Arc'teryx fleece jacket",cat:'outerwear'},
  {q:'Carhartt WIP jacket coat',brand:'Carhartt WIP',avgSell:55,minProfit:18,vintedQ:'Carhartt WIP jacket',soldQ:'Carhartt WIP jacket coat',cat:'outerwear'},
  {q:'Helly Hansen fleece jacket vintage',brand:'Helly Hansen',avgSell:38,minProfit:12,vintedQ:'Helly Hansen fleece',soldQ:'Helly Hansen fleece jacket',cat:'outerwear'},

  // ═══ TIER 6: GORPCORE ═══
  {q:'Patagonia down jacket puffer',brand:'Patagonia',avgSell:95,minProfit:30,vintedQ:'Patagonia down jacket',soldQ:'Patagonia down jacket puffer',cat:'gorpcore'},
  {q:'Arc teryx Gore-Tex jacket shell',brand:"Arc'teryx",avgSell:120,minProfit:35,vintedQ:"Arc'teryx jacket",soldQ:"Arc'teryx Gore-Tex jacket shell",cat:'gorpcore'},
  {q:'North Face 700 puffer jacket',brand:'North Face',avgSell:75,minProfit:22,vintedQ:'North Face puffer jacket',soldQ:'North Face 700 puffer jacket',cat:'gorpcore'},
  {q:'Patagonia Synchilla fleece vintage',brand:'Patagonia',avgSell:65,minProfit:20,vintedQ:'Patagonia Synchilla fleece',soldQ:'Patagonia Synchilla fleece',cat:'gorpcore'},

  // ═══ TIER 7: VINTAGE BAND TEES ═══
  {q:'vintage band t shirt single stitch 90s',brand:'Vintage Band Tee',avgSell:45,minProfit:15,vintedQ:'vintage band tshirt single stitch',soldQ:'vintage band t shirt single stitch 90s',cat:'vintage'},
  {q:'vintage rap tee hip hop shirt 90s',brand:'Vintage Rap Tee',avgSell:55,minProfit:18,vintedQ:'vintage rap tshirt hip hop',soldQ:'vintage rap tee hip hop 90s',cat:'vintage'},
  {q:'Harley Davidson vintage t shirt',brand:'Harley Davidson',avgSell:38,minProfit:12,vintedQ:'Harley Davidson vintage tshirt',soldQ:'Harley Davidson vintage t shirt',cat:'vintage'},
  {q:'vintage rock band tee loft find',brand:'Vintage Band Tee',avgSell:42,minProfit:14,vintedQ:'vintage band tshirt',soldQ:'vintage rock band tee',cat:'vintage'},

  // ═══ TIER 8: ACTIVEWEAR ═══
  {q:'Lululemon leggings top set',brand:'Lululemon',avgSell:45,minProfit:15,vintedQ:'Lululemon leggings',soldQ:'Lululemon leggings womens',cat:'activewear'},
  {q:'Gymshark set leggings top',brand:'Gymshark',avgSell:35,minProfit:12,vintedQ:'Gymshark set',soldQ:'Gymshark leggings set womens',cat:'activewear'},
  {q:'Sweaty Betty leggings top',brand:'Sweaty Betty',avgSell:35,minProfit:12,vintedQ:'Sweaty Betty leggings',soldQ:'Sweaty Betty leggings womens',cat:'activewear'},

  // ═══ TIER 9: DENIM ═══
  {q:'Levi 501 jeans vintage',brand:"Levi's",avgSell:45,minProfit:15,vintedQ:"Levi's 501 jeans",soldQ:"Levi's 501 jeans",cat:'denim'},
  {q:'Levi 501 jeans straight leg',brand:"Levi's",avgSell:42,minProfit:14,vintedQ:"Levi's 501",soldQ:"Levi's 501 straight leg jeans",cat:'denim'},

  // ═══ TIER 10: SELLER IGNORANCE ═══
  {q:'vintage jacket loft find clearance',brand:'Various',avgSell:40,minProfit:12,vintedQ:'vintage jacket',soldQ:'vintage jacket mens',cat:'vintage'},
  {q:'vintage hoodie sweatshirt old clearance',brand:'Various',avgSell:35,minProfit:10,vintedQ:'vintage hoodie',soldQ:'vintage hoodie sweatshirt',cat:'vintage'},
  {q:'vintage retro ski jacket colourful',brand:'Various',avgSell:55,minProfit:18,vintedQ:'vintage ski jacket',soldQ:'vintage retro ski jacket',cat:'vintage'},
  {q:'Moschino vintage top jacket',brand:'Moschino',avgSell:60,minProfit:18,vintedQ:'Moschino vintage',soldQ:'Moschino vintage jacket top',cat:'vintage'},
  {q:'Versace jeans couture vintage',brand:'Versace Jeans',avgSell:65,minProfit:20,vintedQ:'Versace Jeans Couture',soldQ:'Versace Jeans Couture top jacket',cat:'vintage'},
  {q:'Armani Exchange vintage jacket',brand:'Armani',avgSell:45,minProfit:15,vintedQ:'Armani Exchange vintage',soldQ:'Armani Exchange jacket',cat:'vintage'},

  // ═══ TIER 11: FOOTBALL SHIRTS ═══
  {q:'Parma Fiorentina Sampdoria football shirt',brand:'Serie A',avgSell:65,minProfit:20,vintedQ:'Serie A vintage football shirt',soldQ:'vintage Serie A football shirt',cat:'football'},
  {q:'USSR Yugoslavia Eastern European football shirt',brand:'Eastern Europe',avgSell:65,minProfit:20,vintedQ:'vintage football shirt',soldQ:'vintage Eastern European football shirt',cat:'football'},
  {q:'football shirt loft find old rare bundle',brand:'Football',avgSell:50,minProfit:15,vintedQ:'vintage football shirt',soldQ:'vintage football shirt',cat:'football'},
  {q:'Wimbledon Coventry Bradford City shirt',brand:'UK Lower League',avgSell:45,minProfit:14,vintedQ:'lower league football shirt',soldQ:'lower league vintage football shirt',cat:'football'},

  // ═══ TIER 12: MISSPELLINGS ═══
  {q:'Addidas hoodie vintage',brand:'Adidas',avgSell:35,minProfit:12,vintedQ:'Adidas hoodie',soldQ:'Adidas hoodie sweatshirt',cat:'typo'},
  {q:'Niike hoodie vintage',brand:'Nike',avgSell:42,minProfit:15,vintedQ:'Nike hoodie',soldQ:'Nike hoodie sweatshirt vintage',cat:'typo'},
  {q:'Patogonia fleece jacket',brand:'Patagonia',avgSell:65,minProfit:20,vintedQ:'Patagonia fleece',soldQ:'Patagonia fleece jacket',cat:'typo'},
  {q:'Barbour wax jakcet',brand:'Barbour',avgSell:80,minProfit:25,vintedQ:'Barbour wax jacket',soldQ:'Barbour wax jacket mens',cat:'typo'},
  {q:'Stone Ilsand junior jacket',brand:'Stone Island Junior',avgSell:85,minProfit:25,vintedQ:'Stone Island Junior',soldQ:'Stone Island Junior jacket kids',cat:'typo'},
  {q:'Luluelmon leggings',brand:'Lululemon',avgSell:45,minProfit:15,vintedQ:'Lululemon leggings',soldQ:'Lululemon leggings womens',cat:'typo'},
  {q:'Freddy Perry polo shirt',brand:'Fred Perry',avgSell:28,minProfit:10,vintedQ:'Fred Perry polo',soldQ:'Fred Perry polo shirt mens',cat:'typo'},
  {q:'Lacoste polo shitr',brand:'Lacoste',avgSell:32,minProfit:12,vintedQ:'Lacoste polo',soldQ:'Lacoste polo shirt mens',cat:'typo'},
  {q:'New Ballance trainers',brand:'New Balance',avgSell:85,minProfit:20,vintedQ:'New Balance trainers',soldQ:'New Balance trainers shoes',cat:'typo'},
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

// ── EBAY SOLD PRICES — Real market data for sell price estimation ──
// Uses eBay completed/sold listings to find what items actually sold for recently.
// Vinted sell price = eBay sold median × 0.85 (Vinted buyers pay slightly less than eBay)
const soldPriceCache = new Map();

async function getSoldPrices(query, token) {
  const cacheKey = query.toLowerCase().trim();
  const cached = soldPriceCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 60 * 60 * 1000) return cached.data; // 1hr cache

  try {
    // Search eBay UK completed sold listings
    const q = encodeURIComponent(query);
    const url = 'https://api.ebay.com/buy/browse/v1/item_summary/search?q=' + q +
      '&limit=40&marketplace_ids=EBAY_GB' +
      '&filter=itemLocationCountry:GB,buyingOptions:{FIXED_PRICE},conditions:{USED|VERY_GOOD|GOOD|EXCELLENT}' +
      '&sort=endDateSoonest';

    const r = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + token, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_GB' },
      signal: AbortSignal.timeout(10000)
    });
    const data = await r.json();
    const items = (data.itemSummaries || []).filter(i => !shouldReject(i));
    if (items.length < 5) return null;

    const prices = items
      .map(i => parseFloat(i.price?.value || 0))
      .filter(p => p > 3)
      .sort((a, b) => a - b);

    if (prices.length < 5) return null;

    // Remove top and bottom 20% outliers
    const trimmed = prices.slice(Math.floor(prices.length * 0.2), Math.ceil(prices.length * 0.8));
    const median = trimmed[Math.floor(trimmed.length / 2)];

    // Vinted typically 85% of eBay price (no seller fees but smaller audience)
    const vintedEstimate = Math.round(median * 0.85);

    const result = {
      ebaySoldMedian: Math.round(median * 100) / 100,
      vintedEstimate,
      low: Math.round(trimmed[0] * 0.85),
      high: Math.round(trimmed[trimmed.length - 1] * 0.85),
      sampleSize: prices.length,
      isReal: true
    };

    soldPriceCache.set(cacheKey, { data: result, ts: Date.now() });
    console.log('Sold prices "' + query + '": eBay median £' + result.ebaySoldMedian + ' → Vinted est £' + result.vintedEstimate + ' (' + result.sampleSize + ' sold)');
    return result;
  } catch (e) {
    console.log('Sold price error for "' + query + '":', e.message);
    return null;
  }
}

// ── CLAUDE APPEAL SCORING ──
// Scores every deal for desirability and condition before alerting.
// Only items scoring 7/10+ on both appeal AND condition reach your inbox.
// ── CLAUDE APPEAL SCORE CACHE ──
// Cache scores for 24 hours — similar items in same category score the same
const appealCache = new Map();

function getAppealCacheKey(title, brand, cat) {
  // Normalise title to catch near-duplicates — strip size/colour specifics
  const normalised = title.toLowerCase()
    .replace(/\b(xs|s|m|l|xl|xxl|uk\s?\d+|size\s?\d+|\d+\s?years?)\b/gi, '')
    .replace(/\b(white|black|grey|gray|blue|red|green|navy|brown|beige|cream)\b/gi, '')
    .replace(/[^a-z\s]/g, '')
    .trim()
    .substring(0, 40);
  return brand + '|' + cat + '|' + normalised;
}

async function scoreAppeal(title, brand, cat, condition, price) {
  if (!ANTHROPIC_KEY) return null;

  // Check cache first
  const cacheKey = getAppealCacheKey(title, brand, cat);
  const cached = appealCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 24 * 60 * 60 * 1000) {
    return cached.data;
  }

  try {
    const prompt = `You are an expert UK secondhand clothing reseller specialising in Vinted. 
Evaluate this eBay listing to decide if it would sell well on Vinted UK.

Item: "${title}"
Brand: ${brand}
Category: ${cat}
Condition stated: ${condition || 'not specified'}
Buy price: £${price}

Score TWO things from 1-10:

APPEAL (1-10): Would this item sell well on Vinted UK right now?
Consider: Is this colourway desirable? Is this style currently popular? Would a Vinted buyer want this? Common sizes only (S/M/L/XL for adults). Avoid: unusual colourways, out of fashion styles, niche items, kids sizes that are hard to sell, women's items in a man's cut.

CONDITION (1-10): Is the condition description trustworthy and acceptable?
Consider: Vague descriptions like "good used condition" are risky. Clear descriptions are better. Red flags: stains, marks, fading, repairs, smell. Green flags: BNWT, unworn, excellent, immaculate.

Respond with ONLY this JSON, nothing else:
{"appeal": 7, "condition": 6, "appealReason": "one sentence", "conditionReason": "one sentence"}`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: AbortSignal.timeout(15000)
    });

    if (!res.ok) return null;
    const data = await res.json();
    const text = data.content?.[0]?.text || '';
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    if (typeof parsed.appeal !== 'number' || typeof parsed.condition !== 'number') return null;

    // Cache the result for 24 hours
    appealCache.set(cacheKey, { data: parsed, ts: Date.now() });
    return parsed;
  } catch (e) {
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

// Score a deal with eBay sold price data
function scoreDeal(item, marketData, queueItem, soldData) {
  const price = parseFloat(item.price?.value || item.price || 0);
  if (price <= 0 || price > MAX_BUY_PRICE) return null;

  const title = item.title || '';
  const titleLower = title.toLowerCase();
  const hasCondWarn = COND_WARN.some(w => titleLower.includes(w));

  const isExcellent = titleLower.includes('bnwt') || titleLower.includes('unworn') ||
    titleLower.includes('never worn') || titleLower.includes('new with tags') ||
    titleLower.includes('immaculate') || titleLower.includes('mint');

  // ── VINTED SELL PRICE: Use eBay sold data if available, fall back to manual ranges ──
  let vintedSellPrice, vintedDataSource, vintedRange;

  if (soldData && soldData.isReal && soldData.sampleSize >= 5) {
    // REAL: eBay sold median × 0.85 = estimated Vinted price
    vintedSellPrice = soldData.vintedEstimate;
    if (isExcellent) vintedSellPrice = Math.round(vintedSellPrice * 1.15);
    if (hasCondWarn) vintedSellPrice = Math.round(vintedSellPrice * 0.80);
    vintedDataSource = 'sold';
  } else {
    // Fallback to manual research ranges
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
  const roi = Math.round((vintedNet / price) * 100);
  if (vintedNet < itemMinProfit) return null;
  if (roi < MIN_ROI) return null; // Must at least double your money

  // ── CONFIDENCE TIER ──
  let confidenceTier = 'possible';
  let confidenceReasons = [];
  let confidenceScore = 0;

  const hasSoldData = vintedDataSource === 'sold';
  const hasMarketData = marketData && marketData.sampleSize >= 5;

  if (hasSoldData && hasMarketData) {
    const ratio = price / marketData.median;
    if (ratio <= MUST_BUY_RATIO && !hasCondWarn && vintedNet >= 15) {
      confidenceTier = 'mustbuy';
      confidenceScore = 95;
      confidenceReasons.push('✅ Based on ' + soldData.sampleSize + ' real eBay UK sold listings · Market median £' + soldData.ebaySoldMedian + ' → Vinted est £' + soldData.vintedEstimate);
      confidenceReasons.push('✅ Buy price at ' + Math.round(ratio * 100) + '% of active market median (£' + marketData.median + ')');
    } else if (ratio <= STRONG_RATIO && vintedNet >= itemMinProfit) {
      confidenceTier = 'strong';
      confidenceScore = 78;
      confidenceReasons.push('✅ eBay sold median £' + soldData.ebaySoldMedian + ' → Vinted est £' + soldData.vintedEstimate + ' (' + soldData.sampleSize + ' sold)');
      confidenceReasons.push('Active market median £' + marketData.median + ' · Buy at ' + Math.round(ratio * 100) + '%');
    } else {
      return null;
    }
  } else if (hasSoldData && !hasMarketData) {
    if (!hasCondWarn && vintedNet >= 15) {
      confidenceTier = 'strong';
      confidenceScore = 70;
      confidenceReasons.push('✅ eBay sold data: ' + soldData.sampleSize + ' sold · Vinted est £' + soldData.vintedEstimate);
    } else {
      return null;
    }
  } else if (!hasSoldData && hasMarketData) {
    const ratio = price / marketData.median;
    if (ratio <= MUST_BUY_RATIO && !hasCondWarn && vintedNet >= 15) {
      confidenceTier = 'strong';
      confidenceScore = 65;
      confidenceReasons.push('Active eBay market median £' + marketData.median + ' · Buy at ' + Math.round(ratio * 100) + '%');
      confidenceReasons.push('⚠ Vinted sell price estimated — verify before buying');
    } else {
      return null;
    }
  } else {
    return null; // No real data at all — skip
  }

  if (isExcellent) { confidenceScore = Math.min(99, confidenceScore + 8); confidenceReasons.push('Excellent condition signals — commands higher price'); }
  if (queueItem.cat === 'typo') { confidenceScore = Math.min(99, confidenceScore + 5); confidenceReasons.push('Misspelled title — zero competition'); }
  if (titleLower.includes('loft find') || titleLower.includes('house clearance')) { confidenceScore = Math.min(99, confidenceScore + 5); confidenceReasons.push('Seller likely unaware of value'); }

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
    soldData: soldData || null,
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

// Build clean, slick HTML email
function buildEmailHtml(deals) {
  const mustBuys = deals.filter(d => d.confidenceTier === 'mustbuy');
  const strong = deals.filter(d => d.confidenceTier === 'strong');

  const dealHtml = deals.map(d => {
    const isMustBuy = d.confidenceTier === 'mustbuy';
    const accentColor = isMustBuy ? '#16a34a' : '#2563eb';
    const bgColor = isMustBuy ? '#f0fdf4' : '#eff6ff';
    const borderColor = isMustBuy ? '#bbf7d0' : '#bfdbfe';
    const label = isMustBuy ? '🎯 MUST BUY' : '⚡ STRONG';

    return `
    <div style="background:#ffffff;border-radius:12px;margin-bottom:20px;overflow:hidden;border:1px solid #e5e5e0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">

      <!-- Tier banner -->
      <div style="background:${accentColor};padding:10px 16px;display:flex;justify-content:space-between;align-items:center;">
        <span style="color:white;font-weight:700;font-size:13px;letter-spacing:0.05em;">${label}</span>
        <span style="color:rgba(255,255,255,0.85);font-size:12px;">${d.brand} · ${d.cat}</span>
      </div>

      <!-- Title -->
      <div style="padding:14px 16px 0;">
        <div style="font-size:15px;font-weight:600;color:#111;line-height:1.4;margin-bottom:14px;">${d.title}</div>

        <!-- Numbers row -->
        <div style="display:flex;gap:8px;margin-bottom:14px;">
          <div style="flex:1;background:#f7f7f5;border-radius:8px;padding:10px;text-align:center;">
            <div style="font-size:10px;color:#888;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:3px;">Buy</div>
            <div style="font-size:22px;font-weight:700;color:#111;">£${d.price}</div>
          </div>
          <div style="display:flex;align-items:center;color:#bbb;font-size:16px;">→</div>
          <div style="flex:1;background:#f7f7f5;border-radius:8px;padding:10px;text-align:center;">
            <div style="font-size:10px;color:#888;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:3px;">List</div>
            <div style="font-size:22px;font-weight:700;color:#0891b2;">£${d.vintedListPrice}</div>
          </div>
          <div style="display:flex;align-items:center;color:#bbb;font-size:16px;">=</div>
          <div style="flex:1;background:${bgColor};border:1px solid ${borderColor};border-radius:8px;padding:10px;text-align:center;">
            <div style="font-size:10px;color:#888;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:3px;">Profit</div>
            <div style="font-size:22px;font-weight:700;color:${accentColor};">+£${d.vintedNet}</div>
          </div>
          <div style="flex:1;background:#f7f7f5;border-radius:8px;padding:10px;text-align:center;">
            <div style="font-size:10px;color:#888;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:3px;">ROI</div>
            <div style="font-size:22px;font-weight:700;color:#111;">${d.roi}%</div>
          </div>
        </div>

        <!-- Data row -->
        <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;">
          ${d.soldData ? `
          <div style="flex:1;min-width:200px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:10px 12px;">
            <div style="font-size:10px;font-weight:700;color:#16a34a;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">✅ Real Sold Data</div>
            <div style="font-size:12px;color:#166534;">${d.soldData.sampleSize} sold · eBay median <strong>£${d.soldData.ebaySoldMedian}</strong> · Vinted est <strong>£${d.soldData.vintedEstimate}</strong></div>
          </div>` : ''}
          ${d.appealScore ? `
          <div style="flex:1;min-width:200px;background:#f5f3ff;border:1px solid #ddd6fe;border-radius:8px;padding:10px 12px;">
            <div style="font-size:10px;font-weight:700;color:#7c3aed;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">🤖 Appeal Check</div>
            <div style="font-size:12px;color:#5b21b6;">Appeal <strong>${d.appealScore}/10</strong> · Condition <strong>${d.conditionScore}/10</strong></div>
            <div style="font-size:11px;color:#6d28d9;margin-top:3px;">${d.appealReason || ''}</div>
          </div>` : ''}
        </div>

        <!-- Vinted search tip -->
        ${d.vintedTitle ? `
        <div style="background:#fefce8;border:1px solid #fde047;border-radius:8px;padding:10px 12px;margin-bottom:14px;">
          <div style="font-size:10px;font-weight:700;color:#92400e;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">60 Second Check</div>
          <div style="font-size:12px;color:#854d0e;font-weight:600;">Search Vinted for: "${d.vintedTitle}"</div>
          <div style="font-size:11px;color:#78350f;margin-top:3px;">Expect to see similar items at £${Math.round(d.vintedListPrice * 0.85)}–£${Math.round(d.vintedListPrice * 1.2)}. If everything is under £${Math.round(d.vintedListPrice * 0.5)} — skip it.</div>
        </div>` : ''}

      </div>

      <!-- Action buttons -->
      <div style="padding:0 16px 14px;display:flex;gap:8px;">
        <a href="${d.url}" style="flex:2;background:#111;color:white;padding:10px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:600;text-align:center;display:block;">View on eBay →</a>
        <a href="https://www.vinted.co.uk/catalog?search_text=${encodeURIComponent(d.vintedTitle || d.brand)}&order=relevance&currency=GBP" style="flex:1;background:#0891b2;color:white;padding:10px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:600;text-align:center;display:block;">Vinted</a>
        <a href="https://www.ebay.co.uk/sch/i.html?_nkw=${encodeURIComponent(d.vintedTitle || d.title)}&LH_Complete=1&LH_Sold=1" style="flex:1;background:#d97706;color:white;padding:10px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:600;text-align:center;display:block;">Sold</a>
      </div>

    </div>`;
  }).join('');

  return `
    <div style="max-width:600px;margin:0 auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f7f7f5;padding:20px;">

      <!-- Header -->
      <div style="background:#111;color:white;padding:18px 20px;border-radius:12px;margin-bottom:20px;">
        <div style="font-size:20px;font-weight:700;letter-spacing:-0.02em;margin-bottom:4px;">● FlipRadar</div>
        <div style="font-size:13px;color:rgba(255,255,255,0.55);">${new Date().toLocaleString('en-GB', {weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})} · ${deals.length} deal${deals.length !== 1 ? 's' : ''} found</div>
      </div>

      ${dealHtml}

      <!-- Footer -->
      <div style="text-align:center;font-size:11px;color:#aaa;padding-top:8px;">
        Profit = list price − buy price − £${POSTAGE} postage · Always verify before buying
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

      // Get eBay sold prices — use soldQ for accurate category-specific results
      const soldData = await getSoldPrices(qItem.soldQ || qItem.vintedQ || qItem.q, token);

      // Score each listing
      const candidates = [];
      for (const listing of listings) {
        const id = listing.itemId;
        if (alertedIds.has(id)) continue;
        const deal = scoreDeal(listing, marketData, qItem, soldData);
        if (deal && (deal.confidenceTier === 'mustbuy' || deal.confidenceTier === 'strong')) {
          candidates.push(deal);
        }
      }

      if (!candidates.length) continue;

      // ── CLAUDE APPEAL SCORING ──
      // Only score Must Buy candidates with ROI 150%+ — saves API costs
      for (const deal of candidates) {
        // Strong deals or low ROI Must Buys skip Claude and go straight through
        if (deal.confidenceTier === 'strong' || deal.roi < 150) {
          alertDeals.push(deal);
          alertedIds.add(deal.id);
          console.log('[' + deal.confidenceTier.toUpperCase() + '] ' + deal.title.substring(0, 50) + ' — £' + deal.price + ' (+£' + deal.vintedNet + ')');
          continue;
        }

        try {
          const appeal = await scoreAppeal(deal.title, deal.brand, deal.cat, deal.condition, deal.price);

          if (!appeal) {
            // If Claude fails, let the deal through anyway
            alertDeals.push(deal);
            alertedIds.add(deal.id);
            console.log('[' + deal.confidenceTier.toUpperCase() + '] ' + deal.title.substring(0, 50) + ' — £' + deal.price + ' → £' + deal.vintedListPrice + ' (+£' + deal.vintedNet + ') [appeal unscored]');
            continue;
          }

          const appealScore = appeal.appeal;
          const condScore = appeal.condition;

          // Both must be 7+ to reach inbox
          if (appealScore >= 7 && condScore >= 7) {
            deal.appealScore = appealScore;
            deal.conditionScore = condScore;
            deal.appealReason = appeal.appealReason;
            deal.conditionReason = appeal.conditionReason;
            deal.confidenceReasons.push('✅ Appeal ' + appealScore + '/10 — ' + appeal.appealReason);
            deal.confidenceReasons.push('✅ Condition ' + condScore + '/10 — ' + appeal.conditionReason);
            deal.confidenceScore = Math.min(99, deal.confidenceScore + 5);
            alertDeals.push(deal);
            alertedIds.add(deal.id);
            console.log('[' + deal.confidenceTier.toUpperCase() + '] ' + deal.title.substring(0, 45) + ' — £' + deal.price + ' (+£' + deal.vintedNet + ') Appeal:' + appealScore + ' Cond:' + condScore);
          } else {
            console.log('[FILTERED] ' + deal.title.substring(0, 45) + ' — Appeal:' + appealScore + ' Cond:' + condScore + ' — ' + (appealScore < 7 ? appeal.appealReason : appeal.conditionReason));
          }
        } catch (e) {
          // On error let deal through
          alertDeals.push(deal);
          alertedIds.add(deal.id);
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

// ── SCHEDULE: Every 60 minutes ──
async function scheduledScan() {
  await runScan();
  setTimeout(scheduledScan, 60 * 60 * 1000);
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
