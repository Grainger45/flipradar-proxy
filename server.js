// FlipRadar Pro - server.js
// The definitive version. Real sold data. Auction sniping. Telegram alerts. No Vinted API.
// ENV VARS: EBAY_APP_ID, ANTHROPIC_API_KEY, RESEND_API_KEY, ALERT_EMAIL, TELEGRAM_TOKEN, TELEGRAM_CHAT_ID

const express = require('express');
const https = require('https');
const http = require('http');
const app = express();
app.use(express.json());

// ── Config ────────────────────────────────────────────────────
const MAX_BUY = parseFloat(process.env.MAX_BUY_PRICE || '20');
const MIN_PROFIT = parseFloat(process.env.MIN_PROFIT || '7');   // lowered from 8
const POSTAGE = 3.50;
const ALERT_EMAIL = process.env.ALERT_EMAIL || 'l.grainger1996@gmail.com';
const SCAN_INTERVAL_MS = 2 * 60 * 1000; // scan every 2 minutes

// Scoring gates — all deal quality rules in one place
const MIN_APPEAL = 7;           // Claude appeal score minimum (0-10)
const MIN_CONDITION = 7;        // Clothing condition minimum
const MIN_CONDITION_FOOTWEAR = 8; // Footwear stricter
const MIN_SOLD_SAMPLE = 3;      // Minimum real eBay sales required
const MUST_BUY_SCORE = 60;      // Score threshold for Must Buy
const STRONG_SCORE = 35;        // Score threshold for Strong Deal
const SUSPEND_AFTER_DAYS = 14;  // Auto-suspend searches with no deals

// ── State ─────────────────────────────────────────────────────
const alertedIds = new Map(); // itemId -> timestamp of last alert
const ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours — prevents repeat alerts on restart
let seenTitles = new Set(); // deduplicate same item across searches
let alertedCount = 0;
let scanCount = 0;
let lastScanTime = null;
let lastDealsAlerted = [];
let recentDeals = []; // last 50 deals for dashboard
let soldDataCache = {}; // cache real sold prices per search term
let purchaseLog = []; // track what you buy and sell for profit analysis

// ── Fetch helper ──────────────────────────────────────────────
function fetchUrl(url, options = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/json,*/*',
        ...options.headers
      },
      ...options
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return fetchUrl(res.headers.location, options).then(resolve).catch(reject);
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Real sold data from eBay completed listings ───────────────
// ── eBay OAuth token (Client Credentials) ────────────────────
let ebayToken = null;
let ebayTokenExpiry = 0;
async function getEbayToken() {
  if (ebayToken && Date.now() < ebayTokenExpiry - 60000) return ebayToken;
  try {
    const creds = Buffer.from(process.env.EBAY_CLIENT_ID + ':' + process.env.EBAY_CLIENT_SECRET).toString('base64');
    const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
      method: 'POST',
      headers: { 'Authorization': 'Basic ' + creds, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope'
    });
    const data = await res.json();
    if (data.access_token) {
      ebayToken = data.access_token;
      ebayTokenExpiry = Date.now() + (data.expires_in * 1000);
      console.log('eBay OAuth token refreshed');
      return ebayToken;
    }
    console.error('eBay token error:', data.error_description);
    return null;
  } catch(e) { console.error('eBay token fetch error:', e.message); return null; }
}

async function getRealSoldData(query) {
  const cacheKey = query.toLowerCase();
  const now = Date.now();

  // Cache for 4 hours
  if (soldDataCache[cacheKey] && (now - soldDataCache[cacheKey].timestamp) < 4 * 60 * 60 * 1000) {
    return soldDataCache[cacheKey].data;
  }

  try {
    // Use eBay Browse API — OAuth based, no allowlist restriction
    const token = await getEbayToken();
    if (!token) { soldDataCache[cacheKey] = { timestamp: now, data: null }; return null; }

    const url = 'https://api.ebay.com/buy/browse/v1/item_summary/search?' + new URLSearchParams({
      q: query,
      filter: 'conditionIds:{3000|4000|5000},buyingOptions:{FIXED_PRICE},deliveryCountry:GB',
      sort: 'endingSoonest',
      limit: '50',
      fieldgroups: 'MATCHING_ITEMS'
    });
    const res = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + token, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_GB', 'Content-Type': 'application/json' }
    });
    const parsed = await res.json();
    const items = parsed?.itemSummaries || [];

    const prices = items
      .map(i => parseFloat(i.price?.value || '0'))
      .filter(p => p >= 3 && p <= 500);

    if (prices.length < 3) {
      soldDataCache[cacheKey] = { timestamp: now, data: null };
      return null;
    }

    prices.sort((a, b) => a - b);
    const trimStart = Math.floor(prices.length * 0.1);
    const trimEnd = Math.ceil(prices.length * 0.9);
    const trimmed = prices.slice(trimStart, trimEnd);
    const median = trimmed[Math.floor(trimmed.length / 2)];

    const data = {
      median: Math.round(median * 100) / 100,
      low: Math.round(trimmed[0] * 100) / 100,
      high: Math.round(trimmed[trimmed.length - 1] * 100) / 100,
      sampleSize: prices.length,
      trimmedSize: trimmed.length
    };

    soldDataCache[cacheKey] = { timestamp: now, data };
    console.log(`Sold data for "${query}": median £${data.median} (${data.sampleSize} sales)`);
    return data;
  } catch(e) {
    console.error(`Sold data error for "${query}":`, e.message);
    return null;
  }
}


// ── Fuzzy brand matching — catches misspellings no other bot finds ──
// ── Sell velocity — estimated days to sell per brand ──────────
// Based on typical Vinted UK sell-through rates
const SELL_VELOCITY = {
  'Nike': { speed: 'Quick', days: 3, label: '🟢 Quick seller (avg 3 days)' },
  'Adidas': { speed: 'Quick', days: 4, label: '🟢 Quick seller (avg 4 days)' },
  "Levi's": { speed: 'Quick', days: 5, label: '🟢 Quick seller (avg 5 days)' },
  'Ralph Lauren': { speed: 'Quick', days: 4, label: '🟢 Quick seller (avg 4 days)' },
  'Stone Island': { speed: 'Quick', days: 3, label: '🟢 Quick seller (avg 3 days)' },
  'CP Company': { speed: 'Quick', days: 4, label: '🟢 Quick seller (avg 4 days)' },
  'Carhartt': { speed: 'Quick', days: 5, label: '🟢 Quick seller (avg 5 days)' },
  'Champion': { speed: 'Consistent', days: 7, label: '🟡 Consistent seller (avg 7 days)' },
  'Tommy Hilfiger': { speed: 'Consistent', days: 7, label: '🟡 Consistent seller (avg 7 days)' },
  'Lacoste': { speed: 'Consistent', days: 7, label: '🟡 Consistent seller (avg 7 days)' },
  'Barbour': { speed: 'Consistent', days: 10, label: '🟡 Consistent seller (avg 10 days)' },
  'North Face': { speed: 'Consistent', days: 8, label: '🟡 Consistent seller (avg 8 days)' },
  'Patagonia': { speed: 'Consistent', days: 10, label: '🟡 Consistent seller (avg 10 days)' },
  'New Balance': { speed: 'Quick', days: 4, label: '🟢 Quick seller (avg 4 days)' },
  'Salomon': { speed: 'Quick', days: 5, label: '🟢 Quick seller (avg 5 days)' },
  'Veja': { speed: 'Consistent', days: 8, label: '🟡 Consistent seller (avg 8 days)' },
  'Dr Martens': { speed: 'Consistent', days: 9, label: '🟡 Consistent seller (avg 9 days)' },
  'Moncler': { speed: 'Slow', days: 21, label: '🔴 Slow seller (avg 21 days) — high value' },
  'Canada Goose': { speed: 'Slow', days: 25, label: '🔴 Slow seller (avg 25 days) — high value' },
  "Arc'teryx": { speed: 'Slow', days: 18, label: '🔴 Slow seller (avg 18 days) — niche' },
  'Fjallraven': { speed: 'Slow', days: 20, label: '🔴 Slow seller (avg 20 days)' },
  'Football': { speed: 'Consistent', days: 10, label: '🟡 Consistent seller (avg 10 days)' },
};
function getSellVelocity(brand) {
  return SELL_VELOCITY[brand] || { speed: 'Unknown', days: null, label: '⚪ Unknown sell speed' };
}

// ── Seasonal weighting — boost/suppress by time of year ────────
function getSeasonalMultiplier(brand, cat) {
  const month = new Date().getMonth(); // 0=Jan, 11=Dec
  const isWinter = month >= 9 || month <= 1; // Oct-Feb
  const isSummer = month >= 5 && month <= 8; // Jun-Sep
  // Winter outerwear — premium in Oct-Feb, depressed in Jun-Sep
  const winterBrands = ['Barbour', 'Canada Goose', 'Moncler', 'North Face', 'Patagonia', "Arc'teryx", 'Fjallraven', 'Napapijri'];
  if (winterBrands.includes(brand) || cat === 'outdoor') {
    if (isWinter) return 1.15; // 15% value boost in winter
    if (isSummer) return 0.80; // 20% value reduction in summer
  }
  // Football shirts — peak Aug-May (season), low Jun-Jul
  if (cat === 'football') {
    if (month >= 7 || month <= 4) return 1.10;
    return 0.85;
  }
  return 1.0;
}

const BRAND_VARIANTS = {
  'Patagonia':   ['patogonia','patagona','pategonia','pattagonia'],
  'Carhartt':    ['carhart','carhatt','cahartt','carharrt'],
  'North Face':  ['nort face','northface','norht face'],
  "Arc'teryx":  ['arcteryx','arc terx','arctyrex'],
  'Stone Island':['stoneisland','stone ilsand','stone iland'],
  'Lululemon':   ['lululemen','lulemon','luluemon'],
  'New Balance': ['new ballance','newbalance','new blance'],
  'Dr Martens':  ['doc martens','doc martins','dr martins'],
  'Salomon':     ['sallomon','salamon'],
  "Levi's":      ['levis levi 501','levi501'],
  'Ralph Lauren':['ralf lauren','ralph lauran'],
  'Barbour':     ['barbour jakcet','barber jacket'],
};
function detectFuzzyBrand(title) {
  const t = title.toLowerCase();
  for (const [brand, variants] of Object.entries(BRAND_VARIANTS)) {
    if (variants.some(v => t.includes(v))) return brand;
  }
  return null;
}

// ── Seller motivation detection ──
const MOTIVATION_SIGNALS = ['moving house','need gone','must go','quick sale',
  'clearing wardrobe','wardrobe clear','declutter','open to offers','never worn',
  'unwanted gift','wrong size','house clearance','loft find','car boot'];
function scoreMotivation(title, desc) {
  const text = ((title||'') + ' ' + (desc||'')).toLowerCase();
  return MOTIVATION_SIGNALS.filter(s => text.includes(s)).length;
}

// ── Search performance tracking — auto-suspend dead searches ──
const searchPerf = new Map();
function recordDeal(q) {
  const p = searchPerf.get(q) || { lastDeal: null, totalDeals: 0, suspended: false };
  p.lastDeal = new Date(); p.totalDeals++; p.suspended = false;
  searchPerf.set(q, p);
}
function isSuspended(q) { return searchPerf.get(q)?.suspended || false; }
async function weeklyCheck() {
  const cutoff = Date.now() - (SUSPEND_AFTER_DAYS * 86400000);
  const suspended = [];
  for (const item of QUEUE) {
    const p = searchPerf.get(item.q);
    if (p && !p.suspended && p.lastDeal && p.lastDeal.getTime() < cutoff) {
      p.suspended = true; searchPerf.set(item.q, p); suspended.push(item.q);
    }
  }
  if (suspended.length) {
    await sendTelegram('⏸ <b>Auto-suspended ' + suspended.length + ' searches</b> (no deals in ' + SUSPEND_AFTER_DAYS + ' days):\n' + suspended.slice(0,8).map(q=>'• '+q.substring(0,35)).join('\n'));
    console.log('[AUTO-SUSPEND]', suspended.join(', '));
  }
}

// ── Search queue ──────────────────────────────────────────────
const QUEUE = [
  // Tier 1: Proven high-volume sellers
  { q: 'Nike vintage hoodie', soldQ: 'Nike vintage hoodie', brand: 'Nike', cat: 'nike' },
  { q: 'Nike tracksuit vintage', soldQ: 'Nike tracksuit vintage', brand: 'Nike', cat: 'nike' },
  { q: 'Adidas vintage hoodie', soldQ: 'Adidas vintage hoodie', brand: 'Adidas', cat: 'adidas' },
  { q: 'Ralph Lauren polo shirt', soldQ: 'Ralph Lauren polo shirt mens', brand: 'Ralph Lauren', cat: 'polo' },
  { q: 'Ralph Lauren hoodie', soldQ: 'Ralph Lauren hoodie', brand: 'Ralph Lauren', cat: 'polo' },
  { q: 'Tommy Hilfiger polo', soldQ: 'Tommy Hilfiger polo shirt', brand: 'Tommy Hilfiger', cat: 'polo' },
  { q: 'Lacoste polo shirt', soldQ: 'Lacoste polo shirt mens', brand: 'Lacoste', cat: 'polo' },
  { q: 'Levi 501 jeans', soldQ: 'Levi 501 jeans vintage', brand: "Levi's", cat: 'jeans' },
  { q: 'New Balance 990 trainers', soldQ: 'New Balance 990 trainers', brand: 'New Balance', cat: 'trainers' },
  { q: 'North Face fleece', soldQ: 'North Face fleece jacket', brand: 'North Face', cat: 'outdoor' },
  { q: 'Patagonia fleece', soldQ: 'Patagonia fleece pullover', brand: 'Patagonia', cat: 'outdoor' },
  { q: 'Carhartt jacket', soldQ: 'Carhartt jacket', brand: 'Carhartt', cat: 'workwear' },
  { q: 'Champion reverse weave hoodie', soldQ: 'Champion reverse weave hoodie', brand: 'Champion', cat: 'vintage' },
  { q: 'Barbour wax jacket', soldQ: 'Barbour wax jacket', brand: 'Barbour', cat: 'outdoor' },

  // Tier 2: Kids designer (fastest selling)
  { q: 'Stone Island Junior jacket', soldQ: 'Stone Island Junior jacket', brand: 'Stone Island Junior', cat: 'kids' },
  { q: 'CP Company Junior jacket', soldQ: 'CP Company Junior jacket', brand: 'CP Company Junior', cat: 'kids' },
  { q: 'Moncler kids jacket', soldQ: 'Moncler kids jacket', brand: 'Moncler Kids', cat: 'kids' },
  { q: 'Ralph Lauren kids boys', soldQ: 'Ralph Lauren kids polo', brand: 'Ralph Lauren', cat: 'kids' },

  // Tier 3: Football shirts
  { q: 'vintage football shirt retro', soldQ: 'vintage football shirt', brand: 'Football', cat: 'football' },
  { q: 'Serie A football shirt vintage', soldQ: 'Serie A football shirt vintage', brand: 'Football', cat: 'football' },
  { q: 'football shirt bundle job lot', soldQ: 'football shirt bundle', brand: 'Football', cat: 'football' },

  // Tier 4: Misspellings (zero competition)
  { q: 'Raplh Lauren polo', soldQ: 'Ralph Lauren polo shirt', brand: 'Ralph Lauren', cat: 'typo' },
  { q: 'Addidas hoodie vintage', soldQ: 'Adidas hoodie vintage', brand: 'Adidas', cat: 'typo' },
  { q: 'Niike hoodie vintage', soldQ: 'Nike hoodie vintage', brand: 'Nike', cat: 'typo' },
  { q: 'Patogonia fleece', soldQ: 'Patagonia fleece', brand: 'Patagonia', cat: 'typo' },
  { q: 'Chamion reverse weave', soldQ: 'Champion reverse weave hoodie', brand: 'Champion', cat: 'typo' },
  { q: 'Barbour jakcet wax', soldQ: 'Barbour wax jacket', brand: 'Barbour', cat: 'typo' },
  { q: 'Stone Ilsand junior', soldQ: 'Stone Island Junior jacket', brand: 'Stone Island Junior', cat: 'typo' },
  { q: 'Tommmy Hilfiger polo', soldQ: 'Tommy Hilfiger polo shirt', brand: 'Tommy Hilfiger', cat: 'typo' },

  // Tier 5: House clearance / hidden gems
  { q: 'vintage jacket loft find', soldQ: 'vintage jacket', brand: 'Various', cat: 'unknown' },
  { q: 'branded jacket house clearance', soldQ: 'branded jacket vintage', brand: 'Various', cat: 'unknown' },
  { q: 'retro ski jacket vintage colourful', soldQ: 'vintage ski jacket', brand: 'Various', cat: 'vintage' },

  // Tier 6: High-value outerwear
  { q: 'Stone Island jacket', soldQ: 'Stone Island jacket', brand: 'Stone Island', cat: 'premium' },
  { q: 'CP Company jacket', soldQ: 'CP Company jacket', brand: 'CP Company', cat: 'premium' },
  { q: 'Moncler jacket', soldQ: 'Moncler jacket', brand: 'Moncler', cat: 'premium' },
  { q: 'Canada Goose jacket', soldQ: 'Canada Goose jacket', brand: 'Canada Goose', cat: 'premium' },
  { q: 'Arcteryx jacket', soldQ: "Arc'teryx jacket", brand: "Arc'teryx", cat: 'outdoor' },
  { q: 'Fjallraven jacket', soldQ: 'Fjallraven jacket', brand: 'Fjallraven', cat: 'outdoor' },
  { q: 'Napapijri jacket', soldQ: 'Napapijri jacket', brand: 'Napapijri', cat: 'outdoor' },

  // Tier 7: Trainers
  { q: 'Adidas Samba trainers', soldQ: 'Adidas Samba trainers', brand: 'Adidas', cat: 'trainers' },
  { q: 'Nike Air Force 1 trainers', soldQ: 'Nike Air Force 1 trainers', brand: 'Nike', cat: 'trainers' },
  { q: 'New Balance 550 trainers', soldQ: 'New Balance 550 trainers', brand: 'New Balance', cat: 'trainers' },
  { q: 'Salomon trainers', soldQ: 'Salomon trail trainers', brand: 'Salomon', cat: 'trainers' },
  { q: 'Veja trainers', soldQ: 'Veja trainers', brand: 'Veja', cat: 'trainers' },
  { q: 'Dr Martens boots', soldQ: 'Dr Martens 1460 boots', brand: 'Dr Martens', cat: 'boots' },

  // Tier 8: More misspellings
  { q: 'Carhart jacket', soldQ: 'Carhartt jacket', brand: 'Carhartt', cat: 'typo' },
  { q: 'Arcterx jacket', soldQ: "Arc'teryx jacket", brand: "Arc'teryx", cat: 'typo' },
  { q: 'Lululemen leggings', soldQ: 'Lululemon leggings womens', brand: 'Lululemon', cat: 'typo' },
  { q: 'New Ballance trainers', soldQ: 'New Balance trainers', brand: 'New Balance', cat: 'typo' },
  { q: 'Doc Martins boots', soldQ: 'Dr Martens boots', brand: 'Dr Martens', cat: 'typo' },
  { q: 'Sallomon trainers', soldQ: 'Salomon trainers', brand: 'Salomon', cat: 'typo' },
  { q: 'Ralf Lauren polo', soldQ: 'Ralph Lauren polo shirt', brand: 'Ralph Lauren', cat: 'typo' },

  // Tier 9: High-value missing brands
  { q: 'Helly Hansen jacket', soldQ: 'Helly Hansen jacket mens', brand: 'Helly Hansen', cat: 'outdoor' },
  { q: 'Fred Perry polo shirt', soldQ: 'Fred Perry polo shirt mens', brand: 'Fred Perry', cat: 'polo' },
  { q: 'Ellesse vintage jacket', soldQ: 'Ellesse vintage jacket', brand: 'Ellesse', cat: 'vintage' },
  { q: 'Fila vintage tracksuit top', soldQ: 'Fila vintage jacket', brand: 'Fila', cat: 'vintage' },
  { q: 'Adidas Originals jacket vintage', soldQ: 'Adidas Originals jacket', brand: 'Adidas', cat: 'adidas' },
  { q: 'Nike ACG jacket', soldQ: 'Nike ACG jacket', brand: 'Nike', cat: 'nike' },
  { q: 'Burberry shirt mens', soldQ: 'Burberry shirt mens', brand: 'Burberry', cat: 'premium' },
  { q: 'Barbour gilet quilted', soldQ: 'Barbour gilet', brand: 'Barbour', cat: 'outdoor' },
  { q: 'Lululemon align leggings', soldQ: 'Lululemon align leggings womens', brand: 'Lululemon', cat: 'activewear' },
  { q: 'Sweaty Betty leggings', soldQ: 'Sweaty Betty leggings womens', brand: 'Sweaty Betty', cat: 'activewear' },
  { q: 'Polo Ralph Lauren shirt Oxford', soldQ: 'Polo Ralph Lauren Oxford shirt', brand: 'Ralph Lauren', cat: 'polo' },
  { q: 'Nike Dunk trainers', soldQ: 'Nike Dunk trainers shoes', brand: 'Nike', cat: 'trainers' },
  { q: 'Asics Gel Kayano trainers', soldQ: 'Asics Gel Kayano trainers', brand: 'Asics', cat: 'trainers' },
  { q: 'On Cloud trainers', soldQ: 'On Cloud running shoes trainers', brand: 'On', cat: 'trainers' },

  // Tier 10: More typos
  { q: 'Helly Hanson jacket', soldQ: 'Helly Hansen jacket', brand: 'Helly Hansen', cat: 'typo' },
  { q: 'Feeed Perry polo', soldQ: 'Fred Perry polo shirt', brand: 'Fred Perry', cat: 'typo' },
  { q: 'Nort Face jacket', soldQ: 'North Face fleece jacket', brand: 'North Face', cat: 'typo' },
  { q: 'Patogonia fleece jacket', soldQ: 'Patagonia fleece pullover', brand: 'Patagonia', cat: 'typo' },
];

// ── Oxfam scanning — uncontested source, no other bot scans this ──
const OXFAM_SEARCHES = [
  { term: 'barbour jacket', brand: 'Barbour', avgSell: 85, cat: 'outdoor' },
  { term: 'stone island jacket', brand: 'Stone Island', avgSell: 110, cat: 'premium' },
  { term: 'patagonia fleece', brand: 'Patagonia', avgSell: 55, cat: 'outdoor' },
  { term: 'north face jacket', brand: 'North Face', avgSell: 45, cat: 'outdoor' },
  { term: 'ralph lauren jacket', brand: 'Ralph Lauren', avgSell: 40, cat: 'polo' },
  { term: 'dr martens boots', brand: 'Dr Martens', avgSell: 65, cat: 'boots' },
  { term: 'new balance trainers', brand: 'New Balance', avgSell: 65, cat: 'trainers' },
  { term: 'levi jeans', brand: "Levi's", avgSell: 35, cat: 'jeans' },
  { term: 'carhartt jacket', brand: 'Carhartt', avgSell: 55, cat: 'workwear' },
  { term: 'cp company jacket', brand: 'CP Company', avgSell: 90, cat: 'premium' },
  { term: 'fjallraven jacket', brand: 'Fjallraven', avgSell: 65, cat: 'outdoor' },
  { term: 'moncler jacket', brand: 'Moncler', avgSell: 180, cat: 'premium' },
  { term: 'canada goose jacket', brand: 'Canada Goose', avgSell: 220, cat: 'premium' },
  { term: 'burberry coat', brand: 'Burberry', avgSell: 120, cat: 'premium' },
  { term: 'salomon trainers', brand: 'Salomon', avgSell: 80, cat: 'trainers' },
  { term: 'adidas samba', brand: 'Adidas', avgSell: 65, cat: 'trainers' },
  { term: 'nike air force', brand: 'Nike', avgSell: 55, cat: 'trainers' },
  { term: 'veja trainers', brand: 'Veja', avgSell: 75, cat: 'trainers' },
];

async function scanOxfam() {
  const deals = [];
  for (const search of OXFAM_SEARCHES) {
    try {
      const url = `https://onlineshop.oxfam.org.uk/search?q=${encodeURIComponent(search.term)}&start=0&sz=20`;
      const html = await fetchUrl(url);
      // Parse product tiles from Oxfam's Salesforce Commerce Cloud HTML
      const priceMatches = [...html.matchAll(/class="[^"]*price[^"]*"[^>]*>[\s\S]*?£([\d.]+)/g)];
      const titleMatches = [...html.matchAll(/class="[^"]*product-name[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/g)];
      const urlMatches   = [...html.matchAll(/href="(\/[^"]*\/product\/[^"]+)"/g)];
      const imgMatches   = [...html.matchAll(/data-src="([^"]*onlineshop\.oxfam[^"]*\.jpg[^"]*)"/g)];

      for (let i = 0; i < Math.min(priceMatches.length, titleMatches.length); i++) {
        const price = parseFloat(priceMatches[i]?.[1] || '0');
        const title = (titleMatches[i]?.[1] || '').replace(/<[^>]+>/g,'').trim();
        const itemUrl = urlMatches[i] ? 'https://onlineshop.oxfam.org.uk' + urlMatches[i][1] : '';
        const image = imgMatches[i]?.[1] || '';
        if (!price || price > MAX_BUY || !title) continue;

        const seasonal = getSeasonalMultiplier(search.brand, search.cat);
        const adjustedSell = search.avgSell * seasonal;
        const net = Math.round((adjustedSell * 0.85 - price - POSTAGE) * 100) / 100;
        if (net < MIN_PROFIT) continue;

        const marketPercent = Math.round((price / adjustedSell) * 100);
        const roi = Math.round((net / price) * 100);
        let score = 0;
        if (marketPercent <= 30) score += 50;
        else if (marketPercent <= 45) score += 40;
        else if (marketPercent <= 60) score += 28;
        else if (marketPercent <= 75) score += 15;
        if (roi >= 150) score += 25;
        else if (roi >= 100) score += 18;
        else if (roi >= 60) score += 10;
        score += 10; // Oxfam bonus — uncontested source

        const tier = score >= MUST_BUY_SCORE ? 'mustbuy' : score >= STRONG_SCORE ? 'strong' : 'possible';
        if (tier === 'possible') continue;

        const velocity = getSellVelocity(search.brand);
        deals.push({
          id: 'oxfam_' + Buffer.from(itemUrl).toString('base64').substring(0,20),
          title, price, url: itemUrl, image,
          brand: search.brand, cat: search.cat,
          vintedListPrice: Math.round(adjustedSell * 0.85),
          ebayListPrice: Math.round(adjustedSell * 0.9),
          vintedNet: net, ebayNet: net, bestNet: net, netProfit: net,
          bestPlatform: 'Vinted', roi, confidenceTier: tier, score,
          marketPercent,
          soldData: { median: adjustedSell, sampleSize: 0, low: 0, high: 0 },
          isAuction: false, bidCount: 0, hoursLeft: null, freeShipping: false,
          source: 'Oxfam', listingType: 'BIN', velocity
        });
      }
      await sleep(800);
    } catch(e) { console.error('Oxfam scan error:', e.message); }
  }
  return deals;
}

// ── eBay search (Buy It Now) — Browse API ────────────────────
async function searchEbayBIN(item, soldData) {
  try {
    if (!soldData || soldData.median < 5) return [];
    const token = await getEbayToken();
    if (!token) return [];

    const url = 'https://api.ebay.com/buy/browse/v1/item_summary/search?' + new URLSearchParams({
      q: item.q,
      filter: `price:[1..${MAX_BUY}],conditionIds:{3000|4000|5000},buyingOptions:{FIXED_PRICE},deliveryCountry:GB`,
      sort: 'newlyListed',
      limit: '50',
    });

    const res = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + token, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_GB' }
    });
    const parsed = await res.json();
    const items = parsed?.itemSummaries || [];
    return processBrowseItems(items, item, soldData, 'BIN');
  } catch(e) {
    console.error(`BIN search error (${item.q}):`, e.message);
    return [];
  }
}

// ── eBay auction sniping — Browse API ────────────────────────
async function searchEbayAuctions(item, soldData) {
  try {
    if (!soldData || soldData.median < 5) return [];
    const token = await getEbayToken();
    if (!token) return [];

    const endingSoon = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
    const url = 'https://api.ebay.com/buy/browse/v1/item_summary/search?' + new URLSearchParams({
      q: item.q,
      filter: `price:[0.99..${MAX_BUY}],conditionIds:{3000|4000|5000},buyingOptions:{AUCTION},deliveryCountry:GB,endDate:[..${endingSoon}]`,
      sort: 'endingSoonest',
      limit: '20',
    });

    const res = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + token, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_GB' }
    });
    const parsed = await res.json();
    const items = parsed?.itemSummaries || [];
    return processBrowseItems(items, item, soldData, 'Auction');
  } catch(e) {
    console.error(`Auction search error (${item.q}):`, e.message);
    return [];
  }
}

function processBrowseItems(items, queueItem, soldData, listingType) {
  const deals = [];
  for (const ebayItem of items) {
    try {
      const price = parseFloat(ebayItem.price?.value || '0');
      if (price < 1 || price > MAX_BUY) continue;

      const title = ebayItem.title || '';
      const titleLow = title.toLowerCase();

      // Block non-UK listings
      const country = ebayItem.itemLocation?.country;
      if (country && country !== 'GB') continue;

      // Block US kids sizing — 2T, 3T, 24M, 18M, 3 Months, toddler, infant, youth
      if (/\d+[tm]|months?|toddler|infant|baby|youth/i.test(title)) continue;

      // Block shorts/cutoffs from Levi's and denim searches
      if (titleLow.includes('levi') || queueItem.cat === 'denim') {
        if (/short|cutoff|cut.off|jort/i.test(title)) continue;
      }

      // Block dresses, skirts and non-clothing in clothing searches
      if (['nike','adidas','polo','outdoor','workwear','vintage'].includes(queueItem.cat)) {
        if (/dress|skirt|costume/i.test(title)) continue;
      }

      const itemId = ebayItem.itemId || '';
      const url = ebayItem.itemWebUrl || '';
      const image = ebayItem.image?.imageUrl || ebayItem.thumbnailImages?.[0]?.imageUrl || '';
      const endDate = ebayItem.itemEndDate || null;
      const bidCount = parseInt(ebayItem.bidCount || '0');
      const freeShipping = ebayItem.shippingOptions?.[0]?.shippingCostType === 'FREE';

      // Calculate real profit using actual sold data + seasonal adjustment
      const seasonal = getSeasonalMultiplier(queueItem.brand, queueItem.cat);
      const adjustedMedian = soldData.median * seasonal;
      const vintedTarget = Math.round(adjustedMedian * 0.85); // list slightly below median
      const ebayTarget = Math.round(adjustedMedian * 0.9);
      const vintedNet = Math.round((vintedTarget - price - POSTAGE) * 100) / 100;
      const ebayNet = Math.round(((ebayTarget * 0.87) - price - POSTAGE) * 100) / 100;
      const bestNet = Math.max(vintedNet, ebayNet);
      const bestPlatform = vintedNet >= ebayNet ? 'Vinted' : 'eBay';
      const roi = Math.round((bestNet / price) * 100);

      if (bestNet < MIN_PROFIT) continue;

      // Calculate how underpriced vs market
      const marketPercent = Math.round((price / soldData.median) * 100);

      // Confidence scoring
      let tier = 'possible';
      let score = 0;
      // How underpriced vs market — loosened thresholds
      if (marketPercent <= 30) score += 50;      // extreme underpricing
      else if (marketPercent <= 45) score += 40; // very underpriced
      else if (marketPercent <= 60) score += 28; // significantly underpriced
      else if (marketPercent <= 75) score += 15; // moderately underpriced
      // ROI — loosened thresholds
      if (roi >= 150) score += 25;
      else if (roi >= 100) score += 18;
      else if (roi >= 60)  score += 10;
      // Data quality bonus
      if (soldData.sampleSize >= 20) score += 10;
      else if (soldData.sampleSize >= 5) score += 5;
      if (freeShipping) score += 5;
      if (listingType === 'Auction' && bidCount === 0) score += 15;

      // Fuzzy brand match bonus
      const fuzzyBrand = detectFuzzyBrand(title);
      if (fuzzyBrand) score += 8;
      // Seller motivation bonus
      const motivScore = scoreMotivation(title, '');
      if (motivScore > 0) score += motivScore * 3;
      if (score >= MUST_BUY_SCORE) tier = 'mustbuy';
      else if (score >= STRONG_SCORE) tier = 'strong';

      // Calculate auction urgency
      let hoursLeft = null;
      if (endDate) {
        hoursLeft = Math.round((new Date(endDate) - Date.now()) / 3600000 * 10) / 10;
      }

      const velocity = getSellVelocity(queueItem.brand);
      deals.push({
        id: itemId, title, price, url, image,
        brand: queueItem.brand, cat: queueItem.cat,
        velocity,
        vintedListPrice: vintedTarget,
        ebayListPrice: ebayTarget,
        vintedNet, ebayNet, bestNet, netProfit: bestNet,
        bestPlatform, roi, confidenceTier: tier, score,
        marketPercent, // "buying at X% of market"
        soldData: {
          median: soldData.median,
          sampleSize: soldData.sampleSize,
          low: soldData.low,
          high: soldData.high
        },
        isAuction: listingType === 'Auction',
        bidCount, hoursLeft, freeShipping,
        source: 'eBay',
        listingType
      });
    } catch(e) { /* skip */ }
  }
  return deals;
}

// ── Claude deal analysis (for must-buy tier only) ─────────────
async function analyseWithClaude(deal) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', max_tokens: 100,
        messages: [{ role: 'user', content: `In 15 words max, why is this a good flip? Title: "${deal.title}" Buy: £${deal.price}, Sell on Vinted: £${deal.vintedListPrice}, Real market median: £${deal.soldData.median}` }]
      })
    });
    const data = await res.json();
    return data.content?.[0]?.text?.trim() || null;
  } catch(e) { return null; }
}

// ── Telegram alert (instant, on your phone) ───────────────────
async function sendTelegram(message) {
  if (!process.env.TELEGRAM_TOKEN || !process.env.TELEGRAM_CHAT_ID) return false;
  try {
    const url = `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendMessage`;
    const body = JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML', disable_web_page_preview: false });
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    return res.ok;
  } catch(e) { return false; }
}

async function sendTelegramPhoto(imageUrl, caption) {
  if (!process.env.TELEGRAM_TOKEN || !process.env.TELEGRAM_CHAT_ID || !imageUrl) return false;
  try {
    const url = `https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/sendPhoto`;
    const body = JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, photo: imageUrl, caption, parse_mode: 'HTML' });
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    return res.ok;
  } catch(e) { return sendTelegram(caption); } // fallback to text
}

// ── Email ─────────────────────────────────────────────────────
async function sendEmail(subject, html) {
  if (process.env.RESEND_API_KEY) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.RESEND_API_KEY}` },
        body: JSON.stringify({ from: 'FlipRadar <onboarding@resend.dev>', to: [ALERT_EMAIL], subject, html })
      });
      if (res.ok) { console.log('Email sent via Resend'); return true; }
    } catch(e) {}
  }
  return false;
}

async function sendDealAlert(deals) {
  if (!deals.length) return;

  // Telegram — instant alerts for each deal
  for (const d of deals) {
    const urgency = d.isAuction && d.hoursLeft ? `\n⏱ Auction ending in ${d.hoursLeft}h` : '';
    const bids = d.isAuction ? ` (${d.bidCount} bids)` : '';
    const msg = `🔥 <b>${d.confidenceTier === 'mustbuy' ? '🎯 MUST BUY' : '⚡ STRONG DEAL'}</b>

<b>${d.title}</b>

💰 Buy: <b>£${d.price}</b>${bids}
📈 Sell on ${d.bestPlatform}: <b>£${d.bestPlatform === 'Vinted' ? d.vintedListPrice : d.ebayListPrice}</b>
✅ Net profit: <b>+£${d.bestNet.toFixed(0)}</b> (${d.roi}% ROI)
📊 Market median: £${d.soldData.median} (${d.soldData.sampleSize} real sales)
💡 Buying at ${d.marketPercent}% of market value
${d.velocity ? d.velocity.label : ''}${urgency}
${d.analysis ? `\n🤖 ${d.analysis}` : ''}

<a href="${d.url}">👉 View on eBay</a>`;

    // Send photo for must-buys, text for strong deals
    if (d.image && d.confidenceTier === 'mustbuy') {
      await sendTelegramPhoto(d.image, msg);
    } else {
      await sendTelegram(msg);
    }
    await sleep(500);
  }

  // Email must-buys only — strong deals go to Telegram only
  const mustBuyDeals = deals.filter(d => d.confidenceTier === 'mustbuy');
  if (mustBuyDeals.length === 0) { console.log('Strong deals only — Telegram sent, no email'); return; }

  // Email digest
  const cards = mustBuyDeals.map(d => `
    <div style="border:1px solid #e5e7eb;border-radius:12px;padding:16px;margin-bottom:16px;font-family:sans-serif;">
      <div style="display:flex;gap:12px;align-items:flex-start;">
        ${d.image ? `<img src="${d.image}" style="width:90px;height:90px;object-fit:cover;border-radius:8px;flex-shrink:0;" />` : ''}
        <div style="flex:1;">
          <div style="margin-bottom:8px;">
            <span style="background:${d.confidenceTier==='mustbuy'?'#EAF3DE':'#FAEEDA'};color:${d.confidenceTier==='mustbuy'?'#3B6D11':'#854F0B'};font-size:11px;font-weight:700;padding:3px 10px;border-radius:20px;">
              ${d.confidenceTier==='mustbuy'?'🎯 Must Buy':'⚡ Strong Deal'}
            </span>
            ${d.isAuction ? `<span style="background:#E6F1FB;color:#185FA5;font-size:11px;font-weight:600;padding:3px 8px;border-radius:20px;margin-left:6px;">⏱ Auction ${d.hoursLeft}h left</span>` : ''}
          </div>
          <p style="font-size:15px;font-weight:700;margin:0 0 4px;color:#111;">${d.title}</p>
          <p style="font-size:12px;color:#9ca3af;margin:0 0 12px;">Buying at <strong>${d.marketPercent}% of market value</strong> · ${d.soldData.sampleSize} real eBay sales · Median £${d.soldData.median}</p>
          <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px;">
            <div style="text-align:center;background:#f9fafb;border-radius:8px;padding:8px;">
              <div style="font-size:10px;color:#9ca3af;">Buy</div>
              <div style="font-size:18px;font-weight:700;color:#111;">£${d.price}</div>
            </div>
            <div style="text-align:center;background:#f9fafb;border-radius:8px;padding:8px;">
              <div style="font-size:10px;color:#9ca3af;">List on ${d.bestPlatform}</div>
              <div style="font-size:18px;font-weight:700;color:#111;">£${d.bestPlatform==='Vinted'?d.vintedListPrice:d.ebayListPrice}</div>
            </div>
            <div style="text-align:center;background:#EAF3DE;border-radius:8px;padding:8px;">
              <div style="font-size:10px;color:#3B6D11;">Profit</div>
              <div style="font-size:18px;font-weight:700;color:#22c55e;">+£${d.bestNet.toFixed(0)}</div>
            </div>
            <div style="text-align:center;background:#E6F1FB;border-radius:8px;padding:8px;">
              <div style="font-size:10px;color:#185FA5;">ROI</div>
              <div style="font-size:18px;font-weight:700;color:#2563eb;">${d.roi}%</div>
            </div>
          </div>
          ${d.velocity ? `<p style="font-size:12px;color:#6b7280;margin:0 0 8px;">${d.velocity.label}</p>` : ''}
          ${d.analysis ? `<p style="font-size:13px;color:#374151;font-style:italic;margin:0 0 12px;">🤖 ${d.analysis}</p>` : ''}
          <div style="display:flex;gap:8px;">
            <a href="${d.url}" style="background:#111;color:#fff;padding:8px 16px;border-radius:8px;font-size:13px;font-weight:600;text-decoration:none;">View on ${d.source || 'eBay'} →</a>
            <a href="https://www.vinted.co.uk/catalog?search_text=${encodeURIComponent(d.title)}&order=newest_first" style="background:#EAF3DE;color:#3B6D11;padding:8px 16px;border-radius:8px;font-size:13px;font-weight:600;text-decoration:none;">Check Vinted →</a>
          </div>
        </div>
      </div>
    </div>`).join('');

  await sendEmail(
    `🔥 FlipRadar: ${mustBuyDeals.length} must-buy deal${mustBuyDeals.length>1?'s':''} — ${new Date().toLocaleString('en-GB')}`,
    `<div style="max-width:640px;margin:0 auto;padding:20px;font-family:sans-serif;">
      <h1 style="font-size:22px;font-weight:700;color:#111;margin:0 0 4px;">🔥 ${mustBuyDeals.length} must-buy deal${mustBuyDeals.length>1?'s':''} found</h1>
      <p style="color:#9ca3af;font-size:12px;margin:0 0 20px;">Real sold data · Buy under £${MAX_BUY} · Min £${MIN_PROFIT} profit · ${new Date().toLocaleString('en-GB')}</p>
      ${cards}
      <p style="font-size:11px;color:#d1d5db;text-align:center;margin-top:20px;">FlipRadar Pro · eBay UK → Vinted arbitrage</p>
    </div>`
  );
}

// ── Main scan ──────────────────────────────────────────────────
let qIdx = 0;

async function runScan() {
  const startTime = Date.now();
  console.log(`[${new Date().toISOString()}] Scanning... (batch ${scanCount + 1})`);

  // Smart rotation — 8 items per scan, mixing sequential + random for full coverage
  // At 8 items/scan every 2 mins = ~240 items/hour, well within 5000/day eBay limit
  const batchSet = new Set();
  for (let i = 0; i < 6; i++) batchSet.add(QUEUE[(qIdx + i) % QUEUE.length]);
  qIdx = (qIdx + 6) % QUEUE.length;
  const shuffled = [...QUEUE].sort(() => Math.random() - 0.5);
  for (const item of shuffled) { if (batchSet.size >= 10) break; batchSet.add(item); }
  const batch = [...batchSet];

  const newDeals = [];

  // Scan Oxfam every 10th scan (~20 mins) — uncontested source
  if (scanCount % 10 === 0) {
    try {
      const oxfamDeals = await scanOxfam();
      for (const deal of oxfamDeals) {
        if (!alertedIds.has(deal.id) || (Date.now() - alertedIds.get(deal.id)) > ALERT_COOLDOWN_MS) newDeals.push(deal);
      }
      if (oxfamDeals.length) console.log(`Oxfam: ${oxfamDeals.length} candidates found`);
    } catch(e) { console.error('Oxfam scan failed:', e.message); }
  }

  for (const item of batch) {
    if (isSuspended(item.q)) { console.log('[SUSPENDED]', item.q.substring(0,40)); continue; }
    try {
      // Get real sold data
      const soldData = await getRealSoldData(item.soldQ);
      if (!soldData) { await sleep(300); continue; }

      // Search BIN listings
      const binDeals = await searchEbayBIN(item, soldData);
      for (const deal of binDeals) {
        if (!alertedIds.has(deal.id) || (Date.now() - alertedIds.get(deal.id)) > ALERT_COOLDOWN_MS) newDeals.push(deal);
      }

      // Search ending auctions
      const auctionDeals = await searchEbayAuctions(item, soldData);
      for (const deal of auctionDeals) {
        if (!alertedIds.has(deal.id) || (Date.now() - alertedIds.get(deal.id)) > ALERT_COOLDOWN_MS) newDeals.push(deal);
      }

      await sleep(400);
    } catch(e) {
      console.error(`Scan error for ${item.q}:`, e.message);
    }
  }

  scanCount++;
  lastScanTime = new Date();

  // Deduplicate by ID and normalised title
  seenTitles.clear();
  const uniqueDeals = [];
  const seenInBatch = new Set();
  for (const deal of newDeals) {
    const normTitle = deal.title.toLowerCase().replace(/[^a-z0-9]/g,'').substring(0,40);
    if (!seenInBatch.has(deal.id) && !seenTitles.has(normTitle)) {
      seenInBatch.add(deal.id); seenTitles.add(normTitle);
      uniqueDeals.push(deal);
    }
  }

  // Sort by score
  uniqueDeals.sort((a, b) => b.score - a.score);

  // Add to recent deals cache (keep last 50)
  recentDeals = [...uniqueDeals, ...recentDeals].slice(0, 50);

  // Only alert on strong/mustbuy
  const alertDeals = uniqueDeals.filter(d => d.confidenceTier === 'mustbuy' || d.confidenceTier === 'strong');

  if (alertDeals.length > 0) {
    console.log(`✅ Found ${alertDeals.length} strong deals — alerting`);

    // Add Claude analysis to must-buy deals
    for (const deal of alertDeals.filter(d => d.confidenceTier === 'mustbuy')) {
      deal.analysis = await analyseWithClaude(deal);
    }

    alertDeals.forEach(d => { alertedIds.set(d.id, Date.now()); recordDeal(d.cat || d.brand); });
    alertedCount += alertDeals.length;
    lastDealsAlerted = alertDeals.slice(0, 5).map(d =>
      `${d.title} (Buy £${d.price} → +£${d.bestNet.toFixed(0)} profit, ${d.roi}% ROI)`
    );

    await sendDealAlert(alertDeals);
  } else {
    console.log(`Scan ${scanCount}: ${uniqueDeals.length} deals found, none strong enough to alert`);
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`Scan completed in ${duration}s`);
}

// ── Schedule ──────────────────────────────────────────────────
function scheduleScan() {
  // Run immediately
  runScan().catch(e => console.error('Scan error:', e));
  // Then every 2 minutes
  setInterval(() => {
    runScan().catch(e => console.error('Scan error:', e));
  }, SCAN_INTERVAL_MS);
  console.log(`Scanning every ${SCAN_INTERVAL_MS / 60000} minutes`);
}

// ── Routes ─────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({
  status: 'ok', version: 'FlipRadar Pro',
  alertEmail: ALERT_EMAIL,
  telegramEnabled: !!(process.env.TELEGRAM_TOKEN && process.env.TELEGRAM_CHAT_ID),
  emailReady: !!process.env.RESEND_API_KEY,
  maxBuyPrice: MAX_BUY, minProfit: MIN_PROFIT,
  queueSize: QUEUE.length, alertedSoFar: alertedCount, alertedIdsTracked: alertedIds.size,
  scanCount, soldDataCached: Object.keys(soldDataCache).length
}));

app.get('/status', (_, res) => res.send(`
  <html><head><meta http-equiv="refresh" content="30"><title>FlipRadar Pro</title>
  <style>body{font-family:sans-serif;max-width:600px;margin:40px auto;padding:20px;background:#f9fafb;}
  .card{background:white;border-radius:12px;padding:16px;margin-bottom:12px;border:1px solid #e5e7eb;}
  .badge{display:inline-block;padding:2px 10px;border-radius:20px;font-size:12px;font-weight:600;}
  .green{background:#EAF3DE;color:#3B6D11;} .amber{background:#FAEEDA;color:#854F0B;}
  </style></head>
  <body>
    <h2>🔥 FlipRadar Pro</h2>
    <div class="card">
      <p><strong>Status:</strong> <span class="badge green">Live ✅</span></p>
      <p><strong>Last scan:</strong> ${lastScanTime ? lastScanTime.toLocaleString('en-GB') : 'Not yet'}</p>
      <p><strong>Scans run:</strong> ${scanCount} · Scanning every 2 minutes</p>
      <p><strong>Deals alerted:</strong> ${alertedCount}</p>
      <p><strong>Sold data cached:</strong> ${Object.keys(soldDataCache).length} search terms</p>
      <p><strong>Email:</strong> ${process.env.RESEND_API_KEY ? '✅ Resend' : '❌ Not configured'}</p>
      <p><strong>Telegram:</strong> ${process.env.TELEGRAM_TOKEN ? '✅ Configured' : '⚠ Not configured (optional but recommended)'}</p>
    </div>
    ${lastDealsAlerted.length ? `
    <div class="card">
      <strong>Last deals alerted:</strong><br>
      ${lastDealsAlerted.map(d => `<p style="margin:4px 0;font-size:13px;">• ${d}</p>`).join('')}
    </div>` : ''}
    ${recentDeals.length ? `
    <div class="card">
      <strong>Recent deals (last scan):</strong><br>
      ${recentDeals.slice(0,10).map(d => `
        <p style="margin:6px 0;font-size:13px;">
          <span class="badge ${d.confidenceTier==='mustbuy'?'green':'amber'}">${d.confidenceTier}</span>
          ${d.title.slice(0,40)}... — Buy £${d.price} → +£${d.bestNet.toFixed(0)} (${d.roi}% ROI)
          <a href="${d.url}" style="color:#2563eb;margin-left:6px;">View →</a>
        </p>`).join('')}
    </div>` : ''}
    <p><a href="/scan">▶ Run scan now</a> | <a href="/test-email">📧 Test email</a> | <a href="/test-telegram">📱 Test Telegram</a></p>
    <p style="color:#9ca3af;font-size:12px;">FlipRadar Pro · Real sold data · No Vinted API · ${new Date().toLocaleString('en-GB')}</p>
  </body></html>
`));

app.get('/deals', async (req, res) => {
  const { q, brand, cat, soldQ } = req.query;
  if (!q) return res.json({ deals: [] });
  const item = { q, soldQ: soldQ || q, brand: brand || 'Various', cat: cat || 'unknown' };
  const soldData = await getRealSoldData(item.soldQ);
  if (!soldData) return res.json({ deals: [], error: 'No sold data available' });
  const binDeals = await searchEbayBIN(item, soldData);
  const auctionDeals = await searchEbayAuctions(item, soldData);
  res.json({ deals: [...binDeals, ...auctionDeals], soldData });
});

app.get('/scan', async (req, res) => {
  res.send('Scan triggered — check /status for results in ~30 seconds.');
  runScan().catch(e => console.error('Manual scan error:', e));
});

app.get('/test-email', async (req, res) => {
  const ok = await sendEmail(
    '✅ FlipRadar Pro email test',
    '<div style="font-family:sans-serif;max-width:400px;margin:40px auto;padding:20px;"><h2>✅ Email working!</h2><p>FlipRadar Pro will email you when strong deals are found. Real sold data powered.</p></div>'
  );
  res.send(ok ? '✅ Test email sent — check your inbox.' : '❌ Email failed — check RESEND_API_KEY in Render.');
});

app.get('/test-telegram', async (req, res) => {
  if (!process.env.TELEGRAM_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
    return res.send('⚠️ Telegram not configured. Add TELEGRAM_TOKEN and TELEGRAM_CHAT_ID to Render env vars for instant phone alerts.');
  }
  const ok = await sendTelegram('✅ <b>FlipRadar Pro</b> — Telegram alerts are working! You\'ll get instant notifications when strong deals are found.');
  res.send(ok ? '✅ Telegram test sent — check your phone.' : '❌ Telegram failed — check bot token and chat ID.');
});

app.get('/sold-data', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json({ error: 'provide ?q=search term' });
  const data = await getRealSoldData(q);
  res.json(data || { error: 'No data found' });
});

app.get('/ping', (_, res) => res.send('pong'));

// Vinted token paste endpoint
let vintedToken = null;
app.post('/refresh-token', (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'No token provided' });
  vintedToken = token;
  console.log('Vinted token set manually');
  res.json({ ok: true, message: 'Vinted token set' });
});
app.get('/refresh-token', (_, res) => res.send(`
  <html><body style="font-family:sans-serif;max-width:400px;margin:40px auto;padding:20px;">
  <h3>Set Vinted Token</h3>
  <textarea id="t" style="width:100%;height:80px;"></textarea><br><br>
  <button onclick="fetch('/refresh-token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:document.getElementById('t').value})}).then(r=>r.json()).then(d=>alert(d.message))">Set Token</button>
  </body></html>
`));

// ── Start ──────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FlipRadar Pro running on port ${PORT}`);
  console.log(`Config: max buy £${MAX_BUY}, min profit £${MIN_PROFIT}, scan every 2 mins`);
  console.log(`Email: ${process.env.RESEND_API_KEY ? 'Resend ✅' : '❌ Not configured'}`);
  console.log(`Telegram: ${process.env.TELEGRAM_TOKEN ? '✅' : 'Not configured'}`);
  console.log('Vinted API scanning: DISABLED');
  scheduleScan();
  // Weekly auto-suspend check
  setInterval(weeklyCheck, 7 * 24 * 60 * 60 * 1000);
  // Telegram command polling
  let lastUpdateId = 0;
  async function pollTelegram() {
    if (!process.env.TELEGRAM_TOKEN) return;
    try {
      const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN}/getUpdates?offset=${lastUpdateId+1}&timeout=0`);
      const d = await r.json();
      if (!d.ok || !d.result?.length) return;
      for (const u of d.result) {
        lastUpdateId = u.update_id;
        const text = (u.message?.text||'').toLowerCase().trim();
        if (text === '/status' || text === '/s') {
          const suspended = [...searchPerf.values()].filter(p=>p.suspended).length;
          await sendTelegram('📊 <b>FlipRadar Status</b>\n⏱ Uptime: '+Math.round(process.uptime()/60)+'m\n🔍 Queue: '+QUEUE.length+' searches\n⏸ Suspended: '+suspended+'\n✅ Deals alerted: '+alertedCount+'\n\nCommands: /status /scan /suspend');
        }
        if (text === '/scan') { await sendTelegram('🔄 Scan triggered...'); runScan().catch(()=>{}); }
        if (text === '/suspend') {
          const s = [...searchPerf.entries()].filter(([,v])=>v.suspended).map(([q])=>q.substring(0,30));
          await sendTelegram(s.length ? '⏸ Suspended:\n'+s.map(q=>'• '+q).join('\n') : '✅ No suspended searches.');
        }
        if (text.startsWith('/bought')) {
          const parts = text.replace('/bought','').trim().split(' ');
          const buyPrice = parseFloat(parts[0]) || 0;
          const item = parts.slice(1).join(' ') || 'unknown';
          if (buyPrice > 0) {
            purchaseLog.push({ item, buyPrice, boughtAt: new Date().toISOString(), soldPrice: null });
            await sendTelegram(`✅ Logged purchase: <b>${item}</b> for £${buyPrice}\nUse /sold ${buyPrice} [sell price] to log the sale.`);
          } else {
            await sendTelegram('Usage: /bought [price] [item name]\nExample: /bought 15 Levi 501 jeans');
          }
        }
        if (text.startsWith('/sold')) {
          const parts = text.replace('/sold','').trim().split(' ');
          const buyPrice = parseFloat(parts[0]) || 0;
          const sellPrice = parseFloat(parts[1]) || 0;
          if (buyPrice > 0 && sellPrice > 0) {
            const entry = purchaseLog.find(p => p.buyPrice === buyPrice && !p.soldPrice);
            if (entry) {
              entry.soldPrice = sellPrice;
              entry.soldAt = new Date().toISOString();
              const profit = sellPrice - buyPrice - 3.50;
              const roi = Math.round((profit / buyPrice) * 100);
              await sendTelegram(`💰 Sale logged!\n📦 Item: <b>${entry.item}</b>\n💸 Bought: £${buyPrice} → Sold: £${sellPrice}\n✅ Profit: <b>+£${profit.toFixed(2)}</b> (${roi}% ROI)`);
            } else {
              await sendTelegram('No matching purchase found. Use /log to see purchase history.');
            }
          } else {
            await sendTelegram('Usage: /sold [buy price] [sell price]\nExample: /sold 15 45');
          }
        }
        if (text === '/log' || text === '/history') {
          if (!purchaseLog.length) { await sendTelegram('No purchases logged yet. Use /bought to log a purchase.'); }
          else {
            const totalProfit = purchaseLog.filter(p=>p.soldPrice).reduce((a,p)=>a+(p.soldPrice-p.buyPrice-3.5),0);
            const msg = '📊 <b>Purchase Log</b>\n\n' +
              purchaseLog.slice(-10).map(p => `• <b>${p.item}</b> — Bought £${p.buyPrice}${p.soldPrice ? ` → Sold £${p.soldPrice} (+£${(p.soldPrice-p.buyPrice-3.5).toFixed(0)})` : ' (unsold)'}`).join('\n') +
              `\n\n💰 Total profit: <b>£${totalProfit.toFixed(2)}</b>`;
            await sendTelegram(msg);
          }
        }
      }
    } catch(e) {}
    setTimeout(pollTelegram, 30000);
  }
  setTimeout(pollTelegram, 5000);
});
