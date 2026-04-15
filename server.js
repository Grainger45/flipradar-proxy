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
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ── TELEGRAM NOTIFICATIONS ──
async function sendTelegram(message) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch('https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: false
      })
    });
  } catch (e) {
    console.log('Telegram error:', e.message);
  }
}
const ALERT_EMAIL = process.env.ALERT_EMAIL;
const POSTAGE = 3.50;
const MIN_NET_PROFIT = 15;
const MAX_BUY_PRICE = 20; // Compromise — £20 max, but only alerts when ROI > 100%
const MUST_BUY_RATIO = 0.40; // Below 40% of market median = Must Buy
const STRONG_RATIO = 0.65;   // Below 65% = Strong (was 0.55 — too tight, missing real deals)
const MIN_ROI = 100; // Must make at least 100% return on buy price (e.g. buy £10, profit £10+)

// ── DEFINITIVE SEARCH QUEUE ──
// Built from real Vinted UK 2026 sell-through data and seller ignorance patterns
// Every item here has a proven Vinted buyer audience and realistic profit margin
const QUEUE = [

  // eBay UK Category IDs:
  // 15709 = Athletic shoes/trainers
  // 57990 = Men's hoodies & sweatshirts
  // 57988 = Men's jackets & coats
  // 11484 = Women's jackets & coats
  // 15689 = Men's jeans
  // 11554 = Women's jeans
  // 57991 = Men's polo shirts
  // 57992 = Men's t-shirts
  // 11484 = Kids outerwear
  // 57989 = Men's activewear
  // 15724 = Women's activewear

  // ═══ TIER 1: TRAINERS ═══
  {q:'Nike Air Force 1 trainers',brand:'Nike',avgSell:55,minProfit:15,vintedQ:'Nike Air Force 1',soldQ:'Nike Air Force 1 trainers shoes',cat:'trainers',catId:'15709'},
  {q:'New Balance 990 991 trainers',brand:'New Balance',avgSell:85,minProfit:20,vintedQ:'New Balance 990 991',soldQ:'New Balance 990 trainers shoes',cat:'trainers',catId:'15709'},
  {q:'New Balance 550 trainers',brand:'New Balance',avgSell:70,minProfit:18,vintedQ:'New Balance 550',soldQ:'New Balance 550 trainers shoes',cat:'trainers',catId:'15709'},
  {q:'Adidas Samba trainers',brand:'Adidas',avgSell:65,minProfit:18,vintedQ:'Adidas Samba',soldQ:'Adidas Samba trainers shoes',cat:'trainers',catId:'15709'},
  {q:'Nike Dunk trainers',brand:'Nike',avgSell:75,minProfit:20,vintedQ:'Nike Dunk',soldQ:'Nike Dunk trainers shoes',cat:'trainers',catId:'15709'},
  {q:'Asics Gel Lyte trainers vintage',brand:'Asics',avgSell:60,minProfit:15,vintedQ:'Asics Gel Lyte',soldQ:'Asics Gel Lyte trainers shoes',cat:'trainers',catId:'15709'},

  // ═══ TIER 2: KIDS DESIGNER ═══
  {q:'Stone Island Junior jacket boys',brand:'Stone Island Junior',avgSell:85,minProfit:25,vintedQ:'Stone Island Junior jacket',soldQ:'Stone Island Junior jacket kids',cat:'kids',catId:'11484'},
  {q:'CP Company Junior jacket kids',brand:'CP Company Junior',avgSell:75,minProfit:22,vintedQ:'CP Company Junior jacket',soldQ:'CP Company Junior jacket kids',cat:'kids',catId:'11484'},
  {q:'Moncler kids jacket boys girls',brand:'Moncler Kids',avgSell:110,minProfit:30,vintedQ:'Moncler kids jacket',soldQ:'Moncler kids jacket boys girls',cat:'kids',catId:'11484'},
  {q:'Burberry kids jacket coat boys',brand:'Burberry Kids',avgSell:60,minProfit:18,vintedQ:'Burberry kids jacket',soldQ:'Burberry kids jacket coat',cat:'kids',catId:'11484'},

  // ═══ TIER 3: PREMIUM POLOS ═══
  {q:'Lacoste polo shirt mens',brand:'Lacoste',avgSell:32,minProfit:12,vintedQ:'Lacoste polo shirt mens',soldQ:'Lacoste polo shirt mens',cat:'polo',catId:'57991'},
  {q:'Fred Perry polo shirt mens',brand:'Fred Perry',avgSell:28,minProfit:10,vintedQ:'Fred Perry polo shirt',soldQ:'Fred Perry polo shirt mens',cat:'polo',catId:'57991'},
  {q:'Tommy Hilfiger polo shirt mens',brand:'Tommy Hilfiger',avgSell:28,minProfit:10,vintedQ:'Tommy Hilfiger polo',soldQ:'Tommy Hilfiger polo shirt mens',cat:'polo',catId:'57991'},

  // ═══ TIER 4: NIKE VINTAGE ═══
  {q:'Nike vintage hoodie sweatshirt',brand:'Nike',avgSell:42,minProfit:15,vintedQ:'Nike vintage hoodie',soldQ:'Nike vintage hoodie sweatshirt',cat:'nike',catId:'57990'},
  {q:'Nike centre swoosh hoodie vintage',brand:'Nike',avgSell:48,minProfit:18,vintedQ:'Nike centre swoosh hoodie',soldQ:'Nike centre swoosh hoodie',cat:'nike',catId:'57990'},
  {q:'Nike spellout sweatshirt vintage',brand:'Nike',avgSell:45,minProfit:16,vintedQ:'Nike spellout sweatshirt',soldQ:'Nike spellout sweatshirt vintage',cat:'nike',catId:'57990'},
  {q:'Nike tech fleece jacket hoodie',brand:'Nike',avgSell:55,minProfit:18,vintedQ:'Nike tech fleece',soldQ:'Nike tech fleece jacket hoodie',cat:'nike',catId:'57988'},
  {q:'Nike ACG jacket vintage',brand:'Nike',avgSell:65,minProfit:20,vintedQ:'Nike ACG jacket',soldQ:'Nike ACG jacket vintage',cat:'nike',catId:'57988'},

  // ═══ TIER 5: OUTERWEAR ═══
  {q:'Barbour wax jacket mens',brand:'Barbour',avgSell:80,minProfit:25,vintedQ:'Barbour wax jacket',soldQ:'Barbour wax jacket mens',cat:'outerwear',catId:'57988'},
  {q:'North Face fleece jacket vintage',brand:'North Face',avgSell:55,minProfit:18,vintedQ:'North Face fleece',soldQ:'North Face fleece jacket',cat:'outerwear',catId:'57988'},
  {q:'Patagonia fleece jacket half zip',brand:'Patagonia',avgSell:65,minProfit:20,vintedQ:'Patagonia fleece',soldQ:'Patagonia fleece jacket half zip',cat:'outerwear',catId:'57988'},
  {q:'Arc teryx fleece jacket mens',brand:"Arc'teryx",avgSell:90,minProfit:28,vintedQ:"Arc'teryx fleece",soldQ:"Arc'teryx fleece jacket",cat:'outerwear',catId:'57988'},
  {q:'Carhartt WIP jacket coat mens',brand:'Carhartt WIP',avgSell:55,minProfit:18,vintedQ:'Carhartt WIP jacket',soldQ:'Carhartt WIP jacket coat',cat:'outerwear',catId:'57988'},
  {q:'Helly Hansen fleece jacket vintage',brand:'Helly Hansen',avgSell:38,minProfit:12,vintedQ:'Helly Hansen fleece',soldQ:'Helly Hansen fleece jacket',cat:'outerwear',catId:'57988'},

  // ═══ TIER 6: GORPCORE ═══
  {q:'Patagonia down jacket puffer',brand:'Patagonia',avgSell:95,minProfit:30,vintedQ:'Patagonia down jacket',soldQ:'Patagonia down jacket puffer',cat:'gorpcore',catId:'57988'},
  {q:'Arc teryx Gore-Tex jacket shell',brand:"Arc'teryx",avgSell:120,minProfit:35,vintedQ:"Arc'teryx jacket",soldQ:"Arc'teryx Gore-Tex jacket shell",cat:'gorpcore',catId:'57988'},
  {q:'North Face 700 puffer jacket',brand:'North Face',avgSell:75,minProfit:22,vintedQ:'North Face puffer jacket',soldQ:'North Face 700 puffer jacket',cat:'gorpcore',catId:'57988'},
  {q:'Patagonia Synchilla fleece vintage',brand:'Patagonia',avgSell:65,minProfit:20,vintedQ:'Patagonia Synchilla fleece',soldQ:'Patagonia Synchilla fleece',cat:'gorpcore',catId:'57988'},

  // ═══ TIER 7: VINTAGE BAND TEES ═══
  {q:'vintage band t shirt single stitch 90s',brand:'Vintage Band Tee',avgSell:45,minProfit:15,vintedQ:'vintage band tshirt single stitch',soldQ:'vintage band t shirt single stitch 90s',cat:'vintage',catId:'57992'},
  {q:'vintage rap tee hip hop shirt 90s',brand:'Vintage Rap Tee',avgSell:55,minProfit:18,vintedQ:'vintage rap tshirt hip hop',soldQ:'vintage rap tee hip hop 90s',cat:'vintage',catId:'57992'},
  {q:'Harley Davidson vintage t shirt',brand:'Harley Davidson',avgSell:38,minProfit:12,vintedQ:'Harley Davidson vintage tshirt',soldQ:'Harley Davidson vintage t shirt',cat:'vintage',catId:'57992'},

  // ═══ TIER 8: ACTIVEWEAR ═══
  {q:'Lululemon leggings womens',brand:'Lululemon',avgSell:45,minProfit:15,vintedQ:'Lululemon leggings',soldQ:'Lululemon leggings womens',cat:'activewear',catId:'15724'},
  {q:'Gymshark leggings set womens',brand:'Gymshark',avgSell:35,minProfit:12,vintedQ:'Gymshark set',soldQ:'Gymshark leggings set womens',cat:'activewear',catId:'15724'},
  {q:'Sweaty Betty leggings womens',brand:'Sweaty Betty',avgSell:35,minProfit:12,vintedQ:'Sweaty Betty leggings',soldQ:'Sweaty Betty leggings womens',cat:'activewear',catId:'15724'},

  // ═══ TIER 9: DENIM ═══
  {q:'Levi 501 jeans mens vintage',brand:"Levi's",avgSell:45,minProfit:15,vintedQ:"Levi's 501 jeans",soldQ:"Levi's 501 jeans mens",cat:'denim',catId:'15689'},
  {q:'Levi 501 jeans womens vintage',brand:"Levi's",avgSell:42,minProfit:14,vintedQ:"Levi's 501",soldQ:"Levi's 501 straight leg jeans womens",cat:'denim',catId:'11554'},

  // ═══ TIER 10: SELLER IGNORANCE ═══
  {q:'vintage jacket mens loft find clearance',brand:'Various',avgSell:40,minProfit:12,vintedQ:'vintage jacket',soldQ:'vintage jacket mens',cat:'vintage',catId:'57988'},
  {q:'vintage hoodie sweatshirt old clearance',brand:'Various',avgSell:35,minProfit:10,vintedQ:'vintage hoodie',soldQ:'vintage hoodie sweatshirt',cat:'vintage',catId:'57990'},
  {q:'vintage retro ski jacket mens',brand:'Various',avgSell:55,minProfit:18,vintedQ:'vintage ski jacket',soldQ:'vintage retro ski jacket',cat:'vintage',catId:'57988'},
  {q:'Moschino vintage jacket mens',brand:'Moschino',avgSell:60,minProfit:18,vintedQ:'Moschino vintage',soldQ:'Moschino vintage jacket',cat:'vintage',catId:'57988'},
  {q:'Versace Jeans Couture vintage jacket',brand:'Versace Jeans',avgSell:65,minProfit:20,vintedQ:'Versace Jeans Couture',soldQ:'Versace Jeans Couture jacket',cat:'vintage',catId:'57988'},
  {q:'Armani Exchange vintage jacket mens',brand:'Armani',avgSell:45,minProfit:15,vintedQ:'Armani Exchange vintage',soldQ:'Armani Exchange jacket',cat:'vintage',catId:'57988'},

  // ═══ TIER 11: FOOTBALL SHIRTS ═══
  {q:'Parma Fiorentina Sampdoria football shirt',brand:'Serie A',avgSell:65,minProfit:20,vintedQ:'Serie A vintage football shirt',soldQ:'vintage Serie A football shirt',cat:'football',catId:'57992'},
  {q:'USSR Yugoslavia Eastern European football shirt',brand:'Eastern Europe',avgSell:65,minProfit:20,vintedQ:'vintage football shirt',soldQ:'vintage Eastern European football shirt',cat:'football',catId:'57992'},
  {q:'Wimbledon Coventry Bradford City shirt vintage',brand:'UK Lower League',avgSell:45,minProfit:14,vintedQ:'lower league football shirt',soldQ:'lower league vintage football shirt',cat:'football',catId:'57992'},

  // ═══ TIER 12: MISSPELLINGS ═══
  {q:'Addidas hoodie vintage',brand:'Adidas',avgSell:35,minProfit:12,vintedQ:'Adidas hoodie',soldQ:'Adidas hoodie sweatshirt',cat:'typo',catId:'57990'},
  {q:'Niike hoodie vintage',brand:'Nike',avgSell:42,minProfit:15,vintedQ:'Nike hoodie',soldQ:'Nike hoodie sweatshirt vintage',cat:'typo',catId:'57990'},
  {q:'Patogonia fleece jacket',brand:'Patagonia',avgSell:65,minProfit:20,vintedQ:'Patagonia fleece',soldQ:'Patagonia fleece jacket',cat:'typo',catId:'57988'},
  {q:'Barbour wax jakcet',brand:'Barbour',avgSell:80,minProfit:25,vintedQ:'Barbour wax jacket',soldQ:'Barbour wax jacket mens',cat:'typo',catId:'57988'},
  {q:'Stone Ilsand junior jacket',brand:'Stone Island Junior',avgSell:85,minProfit:25,vintedQ:'Stone Island Junior',soldQ:'Stone Island Junior jacket kids',cat:'typo',catId:'11484'},
  {q:'New Ballance trainers',brand:'New Balance',avgSell:85,minProfit:20,vintedQ:'New Balance trainers',soldQ:'New Balance trainers shoes',cat:'typo',catId:'15709'},

  // ═══ NEW HIGH-OPPORTUNITY BRANDS (research March 2026) ═══
  // Dr Martens — eBay sellers undervalue, Vinted buyers pay £60-120
  {q:'Dr Martens boots leather',brand:'Dr Martens',avgSell:70,minProfit:22,vintedQ:'Dr Martens boots',soldQ:'Dr Martens boots leather',cat:'boots',catId:'62108'},
  {q:'Dr Martens 1460 boots',brand:'Dr Martens',avgSell:80,minProfit:25,vintedQ:'Dr Martens 1460',soldQ:'Dr Martens 1460 boots',cat:'boots',catId:'62108'},
  {q:'Dr Martens womens boots shoes',brand:'Dr Martens',avgSell:70,minProfit:22,vintedQ:'Dr Martens womens',soldQ:'Dr Martens womens boots',cat:'boots',catId:'62107'},
  {q:'Dr Martins boots',brand:'Dr Martens',avgSell:70,minProfit:22,vintedQ:'Dr Martens boots',soldQ:'Dr Martens boots leather',cat:'typo',catId:'62108'},

  // Salomon — gorpcore trending, eBay sellers have no idea of value
  {q:'Salomon trainers trail shoes',brand:'Salomon',avgSell:80,minProfit:25,vintedQ:'Salomon trainers',soldQ:'Salomon trainers trail running shoes',cat:'trainers',catId:'15709'},
  {q:'Salomon XT-6 shoes',brand:'Salomon',avgSell:100,minProfit:30,vintedQ:'Salomon XT-6',soldQ:'Salomon XT-6 trail shoes',cat:'trainers',catId:'15709'},
  {q:'Sallomon trainers',brand:'Salomon',avgSell:80,minProfit:25,vintedQ:'Salomon trainers',soldQ:'Salomon trainers shoes',cat:'typo',catId:'15709'},

  // Veja — eco brand, premium Vinted prices, cheap on eBay
  {q:'Veja trainers sneakers',brand:'Veja',avgSell:75,minProfit:22,vintedQ:'Veja trainers',soldQ:'Veja trainers sneakers',cat:'trainers',catId:'15709'},
  {q:'Veja V-10 trainers',brand:'Veja',avgSell:85,minProfit:25,vintedQ:'Veja V-10',soldQ:'Veja V-10 trainers',cat:'trainers',catId:'15709'},

  // Birkenstock — always in demand, eBay sellers undervalue
  {q:'Birkenstock sandals Arizona',brand:'Birkenstock',avgSell:55,minProfit:18,vintedQ:'Birkenstock sandals',soldQ:'Birkenstock Arizona sandals',cat:'trainers',catId:'15709'},

  // Ralph Lauren — back in queue, polos still sell well
  {q:'Ralph Lauren polo shirt mens',brand:'Ralph Lauren',avgSell:30,minProfit:12,vintedQ:'Ralph Lauren polo mens',soldQ:'Ralph Lauren polo shirt mens',cat:'polo',catId:'57991'},
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
  'Dr Martens': {low:40,high:120,avg:70},
  'Salomon': {low:50,high:130,avg:85},
  'Veja': {low:45,high:110,avg:75},
  'Birkenstock': {low:30,high:80,avg:50},
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
  'broken zip','bundle of badges','job lot badges','charm','laces',
  'insoles','tongue','spare part','parts only','spares repair',
  'label only','replacement label','spare label','coat label',
  'wax label','care label','swing tag','hang tag','swing label',
  'box only','dust bag only','authenticity card','care card',
  'button only','zip only','buckle only','strap only',
  'repair section','repair material','repair patch','repair kit',
  'replacement patch','spare material','fabric repair'
];

const COND_WARN = [
  'stain','mark','faded','damage','repair','hole','smell','fault',
  'as seen','as is','worn','well worn','tatty','grubby','needs clean'
];

// Small/kids sizes to reject for footwear
const REJECT_SHOE_SIZES = [
  'size 1 ', 'size 2 ', 'size 3 ', 'uk 1 ', 'uk 2 ', 'uk 3 ',
  'uk1 ', 'uk2 ', 'uk3 ', ' sz 1', ' sz 2', ' sz 3',
  'eu 32','eu 33','eu 34','eu 35',
  'size 1/', 'size 2/', 'uk 1/', 'uk 2/'
];

// Kids ages to reject from adult clothing searches  
const REJECT_KIDS_SIZES = [
  ' age 8',' age 9',' age 10',' age 11',' age 12',
  ' 8-9 ',' 9-10 ',' 10-11 ',' 11-12 ',
  ' 8yr',' 9yr',' 10yr',' 11yr',' 12yr',
  '8 years','9 years','10 years','11 years','12 years',
  '14/16','14-16',' age 14',' age 16',
  'kids size','childrens size','childs size',
  'junior size','boys size','girls size',
  'toddler','infant','baby size',
  ' age 1 ',' age 2 ',' age 3 ',' age 4 ',' age 5 ',' age 6 ',' age 7 ',
  '1-2 years','2-3 years','3-4 years','4-5 years','5-6 years','6-7 years',
  'age 18 months','12 months','18 months','24 months',
  'kids boots','kids shoes','kids trainers','boys boots','girls boots'
];

let cachedToken = null;
let tokenExpiry = 0;
const alertedIds = new Set();

// Status tracking
const statusData = {
  startedAt: new Date().toISOString(),
  lastEbayScan: null,
  lastVintedScan: null,
  lastEmailSent: null,
  totalEmailsSent: 0,
  totalDealsFound: 0,
  totalVintedDealsFound: 0,
  lastDeals: []
};

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

function shouldReject(item, queueItem) {
  const text = ((item.title || '') + ' ' + (item.condition || '')).toLowerCase();
  if (item.itemLocation?.country && item.itemLocation.country !== 'GB') return true;
  if (HARD_REJECT.some(w => text.includes(w))) return true;

  // Reject if title contains "label" near a brand name — catches "Barbour label", "coat label" etc
  if (text.includes('label') || text.includes('hang tag') || text.includes('swing tag')) return true;

  // Sanity check — premium brands should never be under £3
  const price = parseFloat(item.price?.value || item.price || 0);
  const premiumBrands = ['barbour','patagonia','arc teryx','stone island','moncler','canada goose','burberry'];
  if (price < 3 && premiumBrands.some(b => text.includes(b))) return true;

  // Reject small/kids shoe sizes for footwear searches
  const isFootwear = queueItem && ['trainers','boots'].includes(queueItem.cat);
  if (isFootwear) {
    if (REJECT_SHOE_SIZES.some(s => text.includes(s))) return true;
  }

  // Reject kids ages from all searches
  if (REJECT_KIDS_SIZES.some(s => text.includes(s))) return true;

  return false;
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

async function scoreAppeal(title, brand, cat, condition, price, imageUrl) {
  if (!ANTHROPIC_KEY) return null;

  // Check cache first
  const cacheKey = getAppealCacheKey(title, brand, cat);
  const cached = appealCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 24 * 60 * 60 * 1000) {
    return cached.data;
  }

  const isFootwear = ['trainers', 'boots'].includes(cat);
  const minCondition = isFootwear ? 8 : 7;

  try {
    const prompt = `You are a professional UK reseller who has bought and sold 10,000+ items. You lose money on bad purchases. Be BRUTALLY strict — 80% of items should fail.

Item: "${title}"
Brand: ${brand}
Category: ${cat}
Condition stated: ${condition || 'not specified'}${condition && condition.toLowerCase().includes('very good') ? ' (NOTE: charity shop Very Good = equivalent to Used/Acceptable on eBay — NOT excellent)' : ''}${condition && condition.toLowerCase().includes('good') && !condition.toLowerCase().includes('very good') ? ' (NOTE: charity shop Good = well worn, likely visible marks)' : ''}
Buy price: £${price}
${isFootwear ? 'FOOTWEAR RULE: Condition must be 8+ — sole wear, creasing and yellowing kill resale value.' : ''}

Score TWO things 1-10. Be strict.

APPEAL (1-10): Would this sell well on Vinted UK within 2 weeks?
- Score 8-10: Core desirable items (black Sambas, white AF1s, popular colourways, common sizes M/L/UK7-9)
- Score 6-7: Decent but not exceptional
- Score 1-5: Hard to sell (unusual colourways, small sizes 1-5 in footwear, niche styles, kids items, accessories)
INSTANTLY SCORE 1 if: laces, socks, charms, accessories, kids sizes, size 1/2/3 footwear, replacement parts, spare parts, damaged, broken zip, toddler, infant, bundle of

CONDITION (1-10):
${isFootwear ? `FOOTWEAR SCORING (strict):
- Score 9-10: BNWT, unworn, new with tags, worn once/twice with clean soles stated
- Score 7-8: Excellent with SPECIFIC detail (e.g. "minimal sole wear", "leather in great condition")  
- Score 1-6: ANY vague description — "good condition", "pre-owned excellent", "great used condition" = MAX 5
- Score 1-3: Any mention of wear, marks, creasing, yellowing` : `
- Score 8-10: BNWT, unworn, immaculate, new with tags
- Score 6-7: Excellent/very good with clear specific description
- Score 1-5: Vague descriptions like "good used condition", "pre-owned excellent" with no specifics`}

${imageUrl ? 'An image of the item is provided. Use it to assess actual condition — look for sole wear, creasing, staining, yellowing, marks.' : ''}

Respond ONLY with this JSON:
{"appeal": 7, "condition": 6, "appealReason": "one sentence max", "conditionReason": "one sentence max"}`;

    // Build message content — include image if available
    const messageContent = imageUrl ? [
      {
        type: 'image',
        source: { type: 'url', url: imageUrl }
      },
      { type: 'text', text: prompt }
    ] : [{ role: 'user', content: prompt }];

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
        messages: imageUrl
          ? [{ role: 'user', content: messageContent }]
          : [{ role: 'user', content: prompt }]
      }),
      signal: AbortSignal.timeout(20000)
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
        ${d.source && d.source !== 'eBay' ? `<div style="display:inline-block;font-size:10px;font-weight:700;color:${d.isAuction ? '#dc2626' : '#7c3aed'};background:${d.isAuction ? '#fef2f2' : '#f5f3ff'};border:1px solid ${d.isAuction ? '#fecaca' : '#ddd6fe'};border-radius:4px;padding:2px 8px;margin-bottom:8px;text-transform:uppercase;letter-spacing:0.05em;">${d.isAuction ? '⏱ ' : ''}${d.source}</div>` : ''}
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

async function sendAlert(deals, isAuctionAlert = false) {
  if (!SENDGRID_KEY || !ALERT_EMAIL) {
    console.log('No email config — skipping alert');
    return;
  }
  const mustBuys = deals.filter(d => d.confidenceTier === 'mustbuy');
  const strong = deals.filter(d => d.confidenceTier === 'strong');
  const subject = isAuctionAlert
    ? `⏱ ${mustBuys.length} AUCTION ending soon — act now! — FlipRadar`
    : mustBuys.length > 0
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
      statusData.lastEmailSent = new Date().toISOString();
      statusData.totalEmailsSent++;
      statusData.lastDeals = deals.slice(0, 5).map(d => ({
        title: d.title?.substring(0, 50),
        price: d.price,
        profit: d.vintedNet,
        tier: d.confidenceTier,
        source: d.isVintedSource ? 'Vinted' : 'eBay'
      }));
    } else {
      const err = await r.text();
      console.error('SendGrid error:', err);
    }
  } catch (e) {
    console.error('Email failed:', e.message);
  }
}

// ── OXFAM ONLINE — JSON API ──
// Confirmed working via browser inspection: 2-step approach
// Step 1: assembler search returns product IDs + prices
// Step 2: products endpoint returns names + routes
// No auth required, no bot detection, zero competition from other bots
async function scanOxfam(searchTerms) {
  const results = [];
  for (const term of searchTerms) {
    try {
      // Step 1 — search for IDs and prices, sorted newest first
      const searchUrl = 'https://onlineshop.oxfam.org.uk/ccstoreui/v1/assembler/assemble?' +
        'No=0&Nrpp=20' +
        '&Nr=AND(product.active%3A1%2CNOT(sku.listPrice%3A0.000000))' +
        '&Ntt=' + encodeURIComponent(term) +
        '&Ns=product.dateAvailable%7C1';

      const r1 = await fetch(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(12000)
      });

      if (!r1.ok) { console.log('Oxfam search HTTP ' + r1.status + ' for: ' + term); continue; }
      const searchData = await r1.json();
      const records = searchData?.resultsList?.records || [];

      // Filter to items under max buy price
      const affordable = records.filter(r => {
        const price = parseFloat(r.attributes?.['sku.minActivePrice']?.[0] || 99999);
        return price > 0 && price <= MAX_BUY_PRICE;
      });

      if (affordable.length === 0) continue;

      // Step 2 — fetch product names for affordable IDs
      const ids = affordable.map(r => r.attributes?.['product.repositoryId']?.[0]).filter(Boolean);
      const priceMap = {};
      affordable.forEach(r => {
        const id = r.attributes?.['product.repositoryId']?.[0];
        if (id) priceMap[id] = parseFloat(r.attributes?.['sku.minActivePrice']?.[0] || 0);
      });

      const productsUrl = 'https://onlineshop.oxfam.org.uk/ccstoreui/v1/products?' +
        'storePriceListGroupId=ukPriceGroup' +
        '&productIds=' + ids.join('%2C') +
        '&fields=id,displayName,listPrice,route,primaryThumbImageURL,x_condition,x_size';

      const r2 = await fetch(productsUrl, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10000)
      });

      if (!r2.ok) continue;
      const productsData = await r2.json();
      const items = productsData?.items || [];

      for (const p of items) {
        const title = p.displayName || '';
        const price = priceMap[p.id] || parseFloat(p.listPrice || 0);
        if (!title || price <= 0 || price > MAX_BUY_PRICE) continue;

        // Reject kids items
        const titleLow = title.toLowerCase();
        if (REJECT_KIDS_SIZES.some(s => titleLow.includes(s))) continue;
        if (['toddler','infant','childrens','children\'s','boys ','girls '].some(w => titleLow.includes(w))) continue;

        // Build image URL from Oxfam's image CDN pattern
        const imageUrl = p.primaryThumbImageURL
          ? 'https://onlineshop.oxfam.org.uk' + p.primaryThumbImageURL.replace('/thumb/', '/large/')
          : null;
        const condition = p.x_condition || '';
        const size = p.x_size || '';

        results.push({
          title: title.substring(0, 80),
          price,
          url: 'https://onlineshop.oxfam.org.uk' + (p.route || ''),
          source: 'Oxfam Online',
          searchTerm: term,
          image: imageUrl,
          condition,
          size
        });
      }

      await new Promise(r => setTimeout(r, 600));
    } catch (e) {
      console.log('Oxfam error for "' + term + '":', e.message);
    }
  }
  console.log('Oxfam: ' + results.length + ' items found under £' + MAX_BUY_PRICE);
  return results;
}

// ── VINTED SCANNER — Cookie Factory + Internal API ──
// Uses Vinted's internal API directly — same approach as VintedSeekers, Souk etc
// Cookie factory: get session cookie once, use for all API calls = instant responses
const VINTED_TARGETS = [
  // Outerwear — proven sellers
  { search: 'Patagonia fleece jacket', brand: 'Patagonia', avgSell: 55, minProfit: 18, cat: 'outerwear' },
  { search: 'North Face fleece jacket', brand: 'North Face', avgSell: 45, minProfit: 15, cat: 'outerwear' },
  { search: 'Barbour wax jacket', brand: 'Barbour', avgSell: 70, minProfit: 22, cat: 'outerwear' },
  { search: 'Stone Island jacket', brand: 'Stone Island', avgSell: 110, minProfit: 35, cat: 'outerwear' },
  { search: "Arc'teryx jacket", brand: "Arc'teryx", avgSell: 110, minProfit: 35, cat: 'gorpcore' },
  { search: 'Patagonia down jacket', brand: 'Patagonia', avgSell: 80, minProfit: 25, cat: 'outerwear' },
  { search: 'Carhartt WIP jacket', brand: 'Carhartt WIP', avgSell: 50, minProfit: 16, cat: 'outerwear' },
  // Trainers — 61% sell-through rate, New Balance leads
  { search: 'Adidas Samba trainers', brand: 'Adidas', avgSell: 48, minProfit: 15, cat: 'trainers' },
  { search: 'New Balance 550 trainers', brand: 'New Balance', avgSell: 65, minProfit: 20, cat: 'trainers' },
  { search: 'New Balance 990 trainers', brand: 'New Balance', avgSell: 80, minProfit: 25, cat: 'trainers' },
  { search: 'Salomon trainers', brand: 'Salomon', avgSell: 70, minProfit: 22, cat: 'trainers' },
  { search: 'Veja trainers', brand: 'Veja', avgSell: 60, minProfit: 18, cat: 'trainers' },
  { search: 'Dr Martens boots', brand: 'Dr Martens', avgSell: 60, minProfit: 20, cat: 'boots' },
  // Nike vintage — strong demand
  { search: 'Nike vintage hoodie', brand: 'Nike', avgSell: 38, minProfit: 12, cat: 'nike' },
  { search: 'Nike ACG jacket', brand: 'Nike', avgSell: 65, minProfit: 20, cat: 'nike' },
  // Football shirts — massive UK→US arbitrage opportunity, £10-30 → $60-200
  { search: 'England football shirt 1990s vintage', brand: 'England', avgSell: 65, minProfit: 22, cat: 'football' },
  { search: 'Manchester United football shirt vintage', brand: 'Manchester United', avgSell: 55, minProfit: 18, cat: 'football' },
  { search: 'Liverpool football shirt vintage', brand: 'Liverpool', avgSell: 55, minProfit: 18, cat: 'football' },
  { search: 'Umbro football shirt vintage 90s', brand: 'Umbro', avgSell: 45, minProfit: 15, cat: 'football' },
  // CP Company — strong resale
  { search: 'CP Company jacket', brand: 'CP Company', avgSell: 90, minProfit: 30, cat: 'outerwear' },
];

// Track last seen item IDs per search to only process new listings
const vintedLastSeen = new Map();

// Cookie factory — get session cookie from Vinted, refresh every 2 hours
let vintedCookie = null;
let vintedCookieExpiry = 0;

async function getVintedCookie() {
  if (vintedCookie && Date.now() < vintedCookieExpiry) return vintedCookie;
  try {
    const r = await fetch('https://www.vinted.co.uk', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-GB,en;q=0.9',
      },
      signal: AbortSignal.timeout(10000)
    });
    const cookies = r.headers.get('set-cookie') || '';
    // Extract all cookies and combine them
    const cookieStr = cookies.split(',').map(c => c.split(';')[0].trim()).join('; ');
    if (cookieStr) {
      vintedCookie = cookieStr;
      vintedCookieExpiry = Date.now() + 2 * 60 * 60 * 1000; // 2 hours
      console.log('Vinted cookie refreshed');
      return vintedCookie;
    }
  } catch (e) {
    console.log('Vinted cookie error:', e.message);
  }
  return null;
}

// ── VINTED TOKEN MANAGEMENT ──
// Token is set via /refresh-token page (paste JWT from browser DevTools)
// Bot sends Telegram alert when token is missing/expired
let vintedAccessToken = null;
let vintedTokenExpiry = 0;
let vintedRefreshToken = null;
let vintedTokenAlertSent = false; // Avoid spamming Telegram

async function getVintedToken() {
  // Return cached in-memory token if still valid (with 10 min buffer)
  if (vintedAccessToken && Date.now() < vintedTokenExpiry - 600000) {
    return vintedAccessToken;
  }

  // Try env var VINTED_TOKEN as fallback
  const envToken = process.env.VINTED_TOKEN;
  if (envToken) {
    try {
      const payload = JSON.parse(Buffer.from(envToken.split('.')[1], 'base64').toString());
      if (payload.exp && payload.exp * 1000 > Date.now() + 600000) {
        vintedAccessToken = envToken;
        vintedTokenExpiry = payload.exp * 1000;
        vintedTokenAlertSent = false;
        console.log('Vinted: env token valid for ' + Math.round((vintedTokenExpiry - Date.now()) / 60000) + ' more mins');
        return vintedAccessToken;
      }
    } catch(e) {
      // Invalid JWT format — ignore
    }
  }

  // Try auto-refresh using stored refresh token
  if (vintedRefreshToken) {
    try {
      console.log('Vinted: attempting silent token refresh...');
      const r = await fetch('https://www.vinted.co.uk/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
        body: 'grant_type=refresh_token&client_id=web&refresh_token=' + encodeURIComponent(vintedRefreshToken)
      });
      if (r.ok) {
        const data = await r.json();
        if (data.access_token) {
          vintedAccessToken = data.access_token;
          vintedTokenExpiry = Date.now() + (data.expires_in ? data.expires_in * 1000 : 2 * 60 * 60 * 1000);
          if (data.refresh_token) vintedRefreshToken = data.refresh_token;
          vintedTokenAlertSent = false;
          console.log('Vinted: silent token refresh successful, valid for ' + Math.round((vintedTokenExpiry - Date.now()) / 60000) + ' mins');
          return vintedAccessToken;
        }
      }
      console.log('Vinted: silent refresh failed status ' + r.status + ' — clearing refresh token');
      vintedRefreshToken = null; // Refresh token is invalid, clear it
    } catch(e) {
      console.log('Vinted: silent refresh error:', e.message);
    }
  }

  // Token expired or missing — alert once via Telegram then wait
  if (!vintedTokenAlertSent) {
    vintedTokenAlertSent = true;
    const msg = '⚠️ <b>FlipRadar: Vinted token expired</b>\n\nVinted scanning paused.\n\n👉 <a href="https://flipradar-proxy.onrender.com/refresh-token">Tap here to refresh (30 seconds)</a>';
    await sendTelegram(msg).catch(() => {});
    console.log('Vinted: token expired — Telegram alert sent, scanning paused');
  }
  return null;
}

// Called by /set-token endpoint when user pastes tokens
function setVintedToken(token, refreshToken) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    vintedAccessToken = token;
    vintedTokenExpiry = payload.exp ? payload.exp * 1000 : Date.now() + 2 * 60 * 60 * 1000;
    if (refreshToken) {
      vintedRefreshToken = refreshToken;
      console.log('Vinted: refresh token stored — will auto-refresh silently');
    }
    vintedTokenAlertSent = false;
    const minsLeft = Math.round((vintedTokenExpiry - Date.now()) / 60000);
    console.log('Vinted: token set, valid for ' + minsLeft + ' mins' + (refreshToken ? ', auto-refresh enabled' : ''));
    return { ok: true, minsLeft, autoRefresh: !!refreshToken };
  } catch(e) {
    return { ok: false, error: 'Invalid JWT token format — make sure you copied access_token_web' };
  }
}

async function scanVinted(targets) {
  const searchTargets = targets || VINTED_TARGETS;
  const results = [];
  const token = await getVintedToken();

  if (!token) {
    console.log('Vinted: no valid token available');
    return results;
  }

  for (const target of searchTargets) {
    try {
      const maxBuy = Math.floor(target.avgSell - target.minProfit - POSTAGE);
      if (maxBuy <= 3) continue;

      // Use Vinted API v2 directly with Bearer token — clean JSON, no scraping
      const url = 'https://www.vinted.co.uk/api/v2/catalog/items?' +
        'search_text=' + encodeURIComponent(target.search) +
        '&price_to=' + maxBuy +
        '&currency=GBP' +
        '&order=newest_first' +
        '&per_page=48';

      const r = await fetch(url, {
        headers: {
          'Authorization': 'Bearer ' + token,
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        signal: AbortSignal.timeout(10000)
      });

      if (!r.ok) {
        console.log('Vinted API ' + r.status + ' for: ' + target.search);
        if (r.status === 401) console.log('Token expired — refresh VINTED_TOKEN in Render');
        continue;
      }

      const data = await r.json();
      const apiItems = data.items || [];
      console.log('[VINTED] "' + target.search + '" — API returned ' + apiItems.length + ' items (max £' + maxBuy + ')');

      const lastSeen = vintedLastSeen.get(target.search) || new Set();
      const newLastSeen = new Set();
      const items = [];

      for (const item of apiItems) {
        const itemId = String(item.id);
        newLastSeen.add(itemId);
        if (lastSeen.has(itemId)) continue;

        const price = parseFloat(item.price?.amount || item.price || 0);
        if (price <= 0 || price > maxBuy) continue;

        const title = item.title || '';
        const titleLow = title.toLowerCase();

        // Brand check
        const brandLow = target.brand.toLowerCase().replace(/[']/g, '');
        const titleNorm = titleLow.replace(/[']/g, '');
        if (!titleNorm.includes(brandLow) && !titleNorm.includes(brandLow.split(' ')[0])) continue;

        // Reject kids/accessories
        if (HARD_REJECT.some(w => titleLow.includes(w))) continue;
        if (REJECT_KIDS_SIZES.some(s => titleLow.includes(s))) continue;
        if (['kids', 'toddler', 'junior', 'infant', 'baby', 'boys', 'girls', 'youth'].some(w => titleLow.includes(w))) continue;

        const imageUrl = item.photo?.url || item.photos?.[0]?.url || null;

        items.push({
          itemId,
          title: title.substring(0, 80),
          price,
          url: 'https://www.vinted.co.uk/items/' + itemId,
          brand: target.brand,
          cat: target.cat,
          avgSell: target.avgSell,
          minProfit: target.minProfit,
          image: imageUrl,
          condition: item.status || '',
          source: 'Vinted'
        });

        if (items.length >= 5) break;
      }

      vintedLastSeen.set(target.search, newLastSeen);
      results.push(...items);

      if (items.length > 0) {
        console.log('[VINTED] "' + target.search + '" — ' + items.length + ' underpriced items found');
      }

    } catch (e) {
      console.log('Vinted scan error for "' + target.search + '":', e.message);
    }
  }

  console.log('Vinted scan complete — ' + results.length + ' total underpriced items found');
  return results;
}

// ── EBAY AUCTION SCANNER ──
// Zero-bid auctions ending within 4 hours — catches items going for pennies
async function scanAuctions(token) {
  const results = [];
  const auctionSearches = [
    { q: 'Nike vintage hoodie sweatshirt', brand: 'Nike', avgSell: 42, minProfit: 15, vintedQ: 'Nike vintage hoodie', soldQ: 'Nike vintage hoodie sweatshirt', cat: 'nike' },
    { q: 'Adidas Samba trainers', brand: 'Adidas', avgSell: 65, minProfit: 18, vintedQ: 'Adidas Samba', soldQ: 'Adidas Samba trainers shoes', cat: 'trainers', catId: '15709' },
    { q: 'Patagonia fleece jacket', brand: 'Patagonia', avgSell: 65, minProfit: 20, vintedQ: 'Patagonia fleece', soldQ: 'Patagonia fleece jacket half zip', cat: 'outerwear', catId: '57988' },
    { q: 'North Face fleece jacket', brand: 'North Face', avgSell: 55, minProfit: 18, vintedQ: 'North Face fleece', soldQ: 'North Face fleece jacket', cat: 'outerwear', catId: '57988' },
    { q: 'Barbour wax jacket', brand: 'Barbour', avgSell: 80, minProfit: 25, vintedQ: 'Barbour wax jacket', soldQ: 'Barbour wax jacket mens', cat: 'outerwear', catId: '57988' },
    { q: 'Dr Martens boots', brand: 'Dr Martens', avgSell: 70, minProfit: 22, vintedQ: 'Dr Martens boots', soldQ: 'Dr Martens boots leather', cat: 'boots', catId: '62108' },
    { q: 'Stone Island Junior jacket', brand: 'Stone Island Junior', avgSell: 85, minProfit: 25, vintedQ: 'Stone Island Junior jacket', soldQ: 'Stone Island Junior jacket kids', cat: 'kids', catId: '11484' },
    { q: 'Levi 501 jeans', brand: "Levi's", avgSell: 45, minProfit: 15, vintedQ: "Levi's 501 jeans", soldQ: "Levi's 501 jeans", cat: 'denim', catId: '15689' },
    { q: 'Arc teryx jacket', brand: "Arc'teryx", avgSell: 120, minProfit: 35, vintedQ: "Arc'teryx jacket", soldQ: "Arc'teryx jacket", cat: 'gorpcore', catId: '57988' },
    { q: 'Salomon trainers shoes', brand: 'Salomon', avgSell: 80, minProfit: 25, vintedQ: 'Salomon trainers', soldQ: 'Salomon trainers trail running shoes', cat: 'trainers', catId: '15709' },
  ];

  for (const qItem of auctionSearches) {
    try {
      const q = encodeURIComponent(qItem.q);
      const catFilter = qItem.catId ? '&category_ids=' + qItem.catId : '';

      // Search for auctions ending within 4 hours with 0-1 bids
      const r = await fetch(
        'https://api.ebay.com/buy/browse/v1/item_summary/search?q=' + q +
        '&limit=10&marketplace_ids=EBAY_GB' +
        '&filter=price:[1..' + MAX_BUY_PRICE + '],priceCurrency:GBP,itemLocationCountry:GB,buyingOptions:{AUCTION},itemEndDate:[..' + new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString() + ']' +
        catFilter +
        '&sort=endDateSoonest', {
        headers: { 'Authorization': 'Bearer ' + token, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_GB' },
        signal: AbortSignal.timeout(10000)
      });

      if (!r.ok) continue;
      const data = await r.json();
      const listings = (data.itemSummaries || []).filter(i => !shouldReject(i));

      for (const listing of listings) {
        // Only zero or very low bid count
        const bidCount = listing.bidCount || 0;
        if (bidCount > 2) continue;

        const hoursLeft = listing.itemEndDate
          ? Math.round((new Date(listing.itemEndDate) - Date.now()) / 3600000 * 10) / 10
          : null;

        results.push({
          ...listing,
          queueItem: qItem,
          hoursLeft,
          bidCount,
          source: 'eBay Auction',
          isAuction: true
        });
      }
      await new Promise(r => setTimeout(r, 500));
    } catch (e) {
      console.log('Auction scan error:', e.message);
    }
  }
  return results;
}

let scanRunning = false;

async function runScan() {
  if (scanRunning) {
    console.log('Scan already in progress — skipping duplicate');
    return;
  }
  scanRunning = true;

  const hour = new Date().getHours();
  if (hour >= 0 && hour < 7) {
    console.log('Night mode — paused until 7am');
    scanRunning = false;
    return;
  }

  console.log('Scan started at ' + new Date().toLocaleString('en-GB'));
  statusData.lastEbayScan = new Date().toISOString();
  let token;
  try { token = await getToken(); } catch (e) { console.error('Token error:', e.message); scanRunning = false; return; }

  const alertDeals = [];

  for (const qItem of QUEUE) {
    try {
      const q = encodeURIComponent(qItem.q);

      // Fetch eBay listings and eBay market data in parallel
      // Use category ID to ensure only correct item types are returned
      const catFilter = qItem.catId ? '&category_ids=' + qItem.catId : '';
      const [ebayRes, marketData] = await Promise.all([
        fetch('https://api.ebay.com/buy/browse/v1/item_summary/search?q=' + q +
          '&limit=20&marketplace_ids=EBAY_GB' +
          '&filter=price:[0..' + MAX_BUY_PRICE + '],priceCurrency:GBP,itemLocationCountry:GB' +
          catFilter +
          '&sort=newlyListed', {
          headers: { 'Authorization': 'Bearer ' + token, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_GB' },
          signal: AbortSignal.timeout(12000)
        }),
        getMarketPrices(qItem.vintedQ || qItem.q, token)
      ]);

      const ebayData = await ebayRes.json();
      // Log eBay API errors so we can diagnose issues
      if (ebayData.errors) { console.log('[EBAY ERR] ' + qItem.q.substring(0,30) + ': ' + JSON.stringify(ebayData.errors[0])); continue; }
      const rawCount = (ebayData.itemSummaries || []).length;
      const listings = (ebayData.itemSummaries || [])
        .filter(l => !shouldReject(l, qItem))
        .slice(0, 12);
      if (rawCount > 0 && !listings.length) console.log('[REJECT-ALL] ' + qItem.q.substring(0,30) + ': ' + rawCount + ' raw → 0 after filters');
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

      // ── CLAUDE SCORING — runs on EVERY candidate, no bypasses ──
      // Every deal from every source must pass Claude appeal + condition check
      const isFootwear = ['trainers', 'boots'].includes(qItem.cat);
      const minCondScore = isFootwear ? 8 : 7;

      candidates.sort((a, b) => b.roi - a.roi);
      const toScore = candidates.slice(0, 3);

      for (const deal of toScore) {
        try {
          // Always pass image — vision catches what titles miss
          const imageUrl = deal.image || null;
          const appeal = await scoreAppeal(deal.title, deal.brand, deal.cat, deal.condition, deal.price, imageUrl);

          if (!appeal) {
            // Claude unavailable — SKIP, never let unscored items through
            console.log('[SKIP-UNSCORED] ' + deal.title.substring(0, 50) + ' — Claude unavailable, skipping to avoid false positives');
            continue;
          }

          const appealScore = appeal.appeal;
          const condScore = appeal.condition;

          if (appealScore >= 7 && condScore >= minCondScore) {
            deal.appealScore = appealScore;
            deal.conditionScore = condScore;
            deal.appealReason = appeal.appealReason;
            deal.conditionReason = appeal.conditionReason;
            deal.confidenceReasons.push('✅ Appeal ' + appealScore + '/10 — ' + appeal.appealReason);
            deal.confidenceReasons.push('✅ Condition ' + condScore + '/10 — ' + appeal.conditionReason);
            deal.confidenceScore = Math.min(99, deal.confidenceScore + 5);
            // Upgrade strong→mustbuy if Claude rates it highly
            if (deal.confidenceTier === 'strong' && appealScore >= 8 && condScore >= 8) {
              deal.confidenceTier = 'mustbuy';
            }
            alertDeals.push(deal);
            alertedIds.add(deal.id);
            console.log('[' + deal.confidenceTier.toUpperCase() + '] ' + deal.title.substring(0, 45) + ' — £' + deal.price + ' (+£' + deal.vintedNet + ') A:' + appealScore + ' C:' + condScore);
          } else {
            console.log('[FILTERED] ' + deal.title.substring(0, 45) + ' — Appeal:' + appealScore + ' Cond:' + condScore + ' (min:' + minCondScore + ') — ' + (appealScore < 7 ? appeal.appealReason : appeal.conditionReason));
          }
        } catch (e) {
          console.log('[SKIP-ERROR] ' + deal.title.substring(0, 45) + ' — scoring error: ' + e.message);
        }
      }

      await new Promise(r => setTimeout(r, 1200)); // Rate limit buffer
    } catch (e) {
      console.error('Error scanning "' + qItem.q + '":', e.message);
    }
  }

  // ── OXFAM ONLINE SCAN ──
  const OXFAM_SEARCHES = [
    { term: 'barbour jacket', brand: 'Barbour', avgSell: 85, minProfit: 22, cat: 'outerwear' },
    { term: 'stone island jacket', brand: 'Stone Island', avgSell: 110, minProfit: 35, cat: 'outerwear' },
    { term: 'patagonia fleece jacket', brand: 'Patagonia', avgSell: 55, minProfit: 18, cat: 'outerwear' },
    { term: 'north face jacket fleece', brand: 'North Face', avgSell: 45, minProfit: 22, cat: 'outerwear' },
    { term: 'arc teryx jacket', brand: "Arc'teryx", avgSell: 110, minProfit: 35, cat: 'outerwear' },
    { term: 'ralph lauren jacket coat', brand: 'Ralph Lauren', avgSell: 40, minProfit: 14, cat: 'outerwear' },
    { term: 'dr martens boots', brand: 'Dr Martens', avgSell: 65, minProfit: 20, cat: 'boots' },
    { term: 'adidas samba trainers', brand: 'Adidas', avgSell: 48, minProfit: 15, cat: 'trainers' },
    { term: 'new balance trainers', brand: 'New Balance', avgSell: 65, minProfit: 20, cat: 'trainers' },
    { term: 'levi jeans', brand: 'Levi', avgSell: 35, minProfit: 12, cat: 'jeans' },
    { term: 'carhartt jacket', brand: 'Carhartt', avgSell: 50, minProfit: 16, cat: 'outerwear' },
    { term: 'cp company jacket', brand: 'CP Company', avgSell: 90, minProfit: 30, cat: 'outerwear' },
  ];
  const oxfamItems = await scanOxfam(OXFAM_SEARCHES.map(s => s.term));
  for (const item of oxfamItems) {
    if (alertedIds.has('oxfam_' + item.url)) continue;
    // Strict brand match — full brand name must appear as a word, not substring
    const cfg = OXFAM_SEARCHES.find(s => {
      const brandLow = s.brand.toLowerCase().replace(/[^a-z0-9\s]/g, '');
      const titleLow2 = item.title.toLowerCase().replace(/[^a-z0-9\s]/g, '');
      // Full brand must appear as a distinct word sequence, not inside another word
      return new RegExp('(?<![a-z])' + brandLow.replace(/\s+/g, '[\\s-]') + '(?![a-z])').test(titleLow2);
    });
    if (!cfg) continue;

    const titleLow = item.title.toLowerCase();

    // Hard reject — condition words in title
    const condReject = ['discolour','discolor','stain','mark','damage','repair','hole','tear',
      'worn','well worn','fault','flaw','smell','odour','crack','broken','missing',
      'poor condition','fair condition','heavily','tatty','grubby'];
    if (condReject.some(w => titleLow.includes(w))) {
      console.log('[OXFAM SKIP] condition: ' + item.title.substring(0, 60));
      continue;
    }

    // Hard reject — small/kids sizes for footwear
    if (['trainers','boots'].includes(cfg.cat)) {
      const sizeMatch = titleLow.match(/size[:\s]+(\d+\.?\d*)/);
      if (sizeMatch) {
        const sz = parseFloat(sizeMatch[1]);
        if (sz <= 6) { console.log('[OXFAM SKIP] size ' + sz + ': ' + item.title.substring(0, 50)); continue; }
      }
      if (['children','kids','junior','toddler','infant'].some(w => titleLow.includes(w))) continue;
    }

    // Profit check — require 60% ROI minimum
    const netProfit = cfg.avgSell - item.price - POSTAGE;
    if (netProfit < cfg.minProfit) continue;
    const roi = Math.round((netProfit / item.price) * 100);
    if (roi < 60) continue;

    // Run Claude vision scoring — same as eBay items
    const scored = await scoreAppeal(item.title, cfg.brand, cfg.cat, item.condition || '', item.price, item.image || null);
    if (scored) {
      const minCond = ['trainers','boots'].includes(cfg.cat) ? 8 : 7;
      if (scored.condition < minCond) {
        console.log('[OXFAM SKIP] Claude condition ' + scored.condition + '/10: ' + item.title.substring(0, 50));
        console.log('  Reason: ' + scored.conditionReason);
        continue;
      }
      if (scored.appeal < 6) {
        console.log('[OXFAM SKIP] Claude appeal ' + scored.appeal + '/10: ' + item.title.substring(0, 50));
        continue;
      }
    }

    // Get real eBay sold prices for accurate profit calculation
    // Use item title words for more specific sold price lookup — avoids "North Face" matching expensive down jackets
    const titleWords = item.title.replace(/size:?\s*\w+/gi, '').replace(/\b(used|good|very|excellent|new)\b/gi, '').trim();
    const soldQuery = titleWords.substring(0, 50);
    const oxfamSoldData = await getSoldPrices(soldQuery, token);
    const realAvgSell = oxfamSoldData?.isReal && oxfamSoldData.sampleSize >= 5
      ? oxfamSoldData.vintedEstimate
      : cfg.avgSell;
    const realNetProfit = realAvgSell - item.price - POSTAGE;
    if (realNetProfit < cfg.minProfit) {
      console.log('[OXFAM SKIP] real sold data shows margin too thin (£' + Math.round(realNetProfit) + '): ' + item.title.substring(0, 50));
      continue;
    }
    const realRoi = Math.round((realNetProfit / item.price) * 100);

    alertedIds.add('oxfam_' + item.url);
    const tier = scored ? (scored.appeal >= 8 && realNetProfit >= cfg.minProfit * 1.5 ? 'mustbuy' : 'good') : (realNetProfit >= cfg.minProfit * 1.5 ? 'mustbuy' : 'good');
    alertDeals.push({
      itemId: 'oxfam_' + item.url,
      title: item.title,
      price: item.price,
      url: item.url,
      source: 'Oxfam Online',
      vintedListPrice: realAvgSell,
      vintedNet: Math.round(realNetProfit),
      roi: realRoi,
      confidenceTier: tier,
      confidenceScore: realNetProfit,
      soldCount: oxfamSoldData?.sampleSize || 0,
      ebayMedian: oxfamSoldData?.ebaySoldMedian || realAvgSell,
      soldData: oxfamSoldData,
      appealScore: scored?.appeal,
      condScore: scored?.condition,
    });
    console.log('[OXFAM' + (tier === 'mustbuy' ? ' 🎯' : '') + '] ' + item.title.substring(0, 50) + ' — £' + item.price + ' → relist £' + realAvgSell + ' (+£' + Math.round(realNetProfit) + ')' + (scored ? ' [A:' + scored.appeal + ' C:' + scored.condition + ']' : ''));
  }
  // ── EBAY AUCTION SCAN — instant alert for ending soon ──
  console.log('Scanning eBay auctions ending within 4 hours...');
  const auctionItems = await scanAuctions(token);
  console.log('Auctions: ' + auctionItems.length + ' zero/low-bid items found');

  const auctionDeals = [];
  for (const item of auctionItems) {
    if (alertedIds.has(item.itemId)) continue;
    const soldData = await getSoldPrices(item.queueItem.soldQ, token);
    const deal = scoreDeal(item, null, item.queueItem, soldData);
    if (deal && deal.confidenceTier === 'mustbuy') {
      deal.source = 'eBay Auction ⏱ ' + item.hoursLeft + 'h left · ' + item.bidCount + ' bids';
      deal.isAuction = true;
      deal.hoursLeft = item.hoursLeft;
      auctionDeals.push(deal);
      alertedIds.add(item.itemId);
      console.log('[AUCTION] ' + deal.title.substring(0, 45) + ' — £' + deal.price + ' · ' + item.hoursLeft + 'h left · ' + item.bidCount + ' bids');
    }
  }

  // Send instant auction alert if any found — separate from regular email
  if (auctionDeals.length > 0) {
    console.log('Sending instant auction alert — ' + auctionDeals.length + ' deals');
    await sendAlert(auctionDeals.slice(0, 5), true);
  }

  // ── REGULAR EMAIL — best Must Buys from eBay + Vinted + Oxfam + Auctions ──
  const mustBuyCount = alertDeals.filter(d => d.confidenceTier === 'mustbuy').length;
  console.log('Scan complete — ' + alertDeals.length + ' deals (' + mustBuyCount + ' Must Buy) across eBay + Vinted + Oxfam + Auctions');

  const mustBuysOnly = alertDeals.filter(d => d.confidenceTier === 'mustbuy');
  if (mustBuysOnly.length > 0) {
    mustBuysOnly.sort((a, b) => b.confidenceScore - a.confidenceScore);
    // Send Telegram for every Must Buy — instant notification regardless of source
    for (const deal of mustBuysOnly.slice(0, 5)) {
      const source = deal.source || 'eBay';
      const emoji = source.includes('Oxfam') ? '🏪' : source.includes('Vinted') ? '👗' : source.includes('Auction') ? '⏱' : '🎯';
      const sourceLabel = source.includes('Oxfam') ? 'OXFAM' : source.includes('Vinted') ? 'VINTED' : source.includes('Auction') ? 'AUCTION' : 'EBAY';
      const msg = emoji + ' <b>' + sourceLabel + ' MUST BUY</b>\n' +
        '<b>' + deal.title.substring(0, 60) + '</b>\n' +
        '💰 Buy <b>£' + deal.price + '</b> → Relist <b>£' + deal.vintedListPrice + '</b>\n' +
        '📈 Profit: <b>+£' + deal.vintedNet + '</b> (' + deal.roi + '% ROI)\n' +
        '🔗 <a href="' + (deal.url || deal.itemWebUrl || '') + '">View listing</a>';
      await sendTelegram(msg);
    }
    await sendAlert(mustBuysOnly.slice(0, 5));
  } else {
    console.log('No Must Buy deals this scan — skipping email');
  }

  if (alertedIds.size > 800) alertedIds.clear();
  scanRunning = false;
}

// ── VINTED SCAN — runs every 30 minutes, rotates through targets ──
let vintedScanRunning = false;
let vintedTargetIndex = 0; // Tracks which searches to run next

async function runVintedScan() {
  if (vintedScanRunning) return;
  vintedScanRunning = true;


  // Run 3 searches per cycle, rotating through all targets
  const batchSize = 3;
  const batch = [];
  for (let i = 0; i < batchSize; i++) {
    batch.push(VINTED_TARGETS[vintedTargetIndex % VINTED_TARGETS.length]);
    vintedTargetIndex++;
  }

  console.log('Vinted scan — batch: ' + batch.map(t => t.search).join(', '));
  statusData.lastVintedScan = new Date().toISOString();

  try {
    const token = await getToken();
    const vintedItems = await scanVinted(batch);
    const vintedDeals = [];

    for (const item of vintedItems) {
      if (alertedIds.has('vinted-' + item.itemId)) continue;
      const netProfit = item.avgSell - item.price - POSTAGE;
      const roi = Math.round((netProfit / item.price) * 100);
      if (netProfit < item.minProfit || roi < MIN_ROI) continue;

      let appealData = null;
      // Always run Claude scoring for Vinted — condition and appeal check on every item
      if (ANTHROPIC_KEY) {
        appealData = await scoreAppeal(item.title, item.brand, item.cat, 'listed on Vinted', item.price, item.image || null);
        if (appealData) {
          const minCond = ['trainers','boots'].includes(item.cat) ? 8 : 7;
          if (appealData.condition < minCond || appealData.appeal < 6) {
            console.log('[VINTED FILTERED] ' + item.title.substring(0, 45) + ' A:' + appealData.appeal + ' C:' + appealData.condition + ' — ' + (appealData.appeal < 6 ? appealData.appealReason : appealData.conditionReason));
            continue;
          }
        }
      }

      const dealId = 'vinted-' + item.itemId;
      const deal = {
        id: dealId,
        title: item.title,
        price: item.price,
        vintedListPrice: item.avgSell,
        vintedNet: Math.round(netProfit * 100) / 100,
        roi,
        brand: item.brand,
        cat: item.cat,
        url: item.url,
        source: '🔍 Vinted Underpriced — Buy & Relist',
        confidenceTier: 'mustbuy',
        confidenceScore: 85,
        confidenceReasons: ['✅ Listed on Vinted below market value', '✅ Buy on Vinted, relist higher for profit'],
        soldData: { isReal: false, sampleSize: 0, ebaySoldMedian: item.avgSell, vintedEstimate: item.avgSell },
        vintedDataSource: 'research',
        appealScore: appealData?.appeal || null,
        conditionScore: appealData?.condition || null,
        appealReason: appealData?.appealReason || null,
        conditionReason: appealData?.conditionReason || null,
        isVintedSource: true
      };

      vintedDeals.push(deal);
      alertedIds.add(dealId);
      console.log('[VINTED DEAL] ' + item.title.substring(0, 50) + ' — £' + item.price + ' → relist £' + item.avgSell + ' (+£' + Math.round(netProfit) + ')');
    }

    if (vintedDeals.length > 0) {
      console.log('Sending Vinted alert — ' + vintedDeals.length + ' underpriced items');
      // Send instant Telegram notification for each Vinted deal
      for (const deal of vintedDeals.slice(0, 3)) {
        const msg = '🔥 <b>VINTED DEAL</b>\n' +
          '<b>' + deal.title.substring(0, 60) + '</b>\n' +
          '💰 Buy <b>£' + deal.price + '</b> → Relist <b>£' + deal.vintedListPrice + '</b>\n' +
          '📈 Profit: <b>+£' + deal.vintedNet + '</b>\n' +
          '🔗 <a href="' + deal.url + '">View on Vinted</a>';
        await sendTelegram(msg);
      }
      await sendAlert(vintedDeals.slice(0, 5));
    } else {
      console.log('Vinted batch complete — no underpriced items this run');
    }
  } catch (e) {
    console.error('Vinted scan error:', e.message);
  }

  vintedScanRunning = false;
}

// ── SCHEDULE: eBay every 15 minutes, Vinted every 5 minutes ──
async function scheduledScan() {
  await runScan();
  setTimeout(scheduledScan, 15 * 60 * 1000); // Every 15 minutes
}

async function scheduledVintedScan() {
  await runVintedScan();
  setTimeout(scheduledVintedScan, 5 * 60 * 1000); // Every 5 minutes
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

// ── TOKEN REFRESH PAGE ──
// Visit this in your browser while logged into Vinted to refresh the token
app.get('/refresh-token', (req, res) => {
  const minsLeft = vintedAccessToken && vintedTokenExpiry > Date.now()
    ? Math.round((vintedTokenExpiry - Date.now()) / 60000) : 0;
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>FlipRadar — Vinted Token</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px 16px; background: #0f0f0f; color: #fff; }
    h1 { color: #22c55e; font-size: 22px; margin-bottom: 8px; }
    .status-badge { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 13px; font-weight: 600; margin-bottom: 16px; }
    .active { background: #052e16; color: #22c55e; border: 1px solid #22c55e; }
    .expired { background: #2d0a0a; color: #ef4444; border: 1px solid #ef4444; }
    .steps { background: #1a1a1a; border-radius: 10px; padding: 16px; margin: 16px 0; }
    .step { display: flex; gap: 12px; margin-bottom: 12px; align-items: flex-start; }
    .step:last-child { margin-bottom: 0; }
    .num { background: #22c55e; color: #000; width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 12px; flex-shrink: 0; margin-top: 2px; }
    .step p { margin: 0; color: #ccc; font-size: 14px; line-height: 1.5; }
    .step code { background: #333; padding: 2px 6px; border-radius: 4px; font-size: 12px; color: #22c55e; }
    textarea { width: 100%; height: 100px; background: #1a1a1a; border: 1px solid #333; border-radius: 8px; color: #fff; padding: 12px; font-family: monospace; font-size: 12px; resize: vertical; margin: 8px 0; }
    textarea:focus { outline: none; border-color: #22c55e; }
    button { background: #22c55e; color: #000; border: none; padding: 14px; font-size: 16px; font-weight: bold; border-radius: 8px; cursor: pointer; width: 100%; }
    button:active { opacity: 0.8; }
    #result { margin-top: 12px; padding: 12px; border-radius: 8px; display: none; font-size: 14px; }
    .ok { background: #052e16; border: 1px solid #22c55e; color: #22c55e; }
    .err { background: #2d0a0a; border: 1px solid #ef4444; color: #ef4444; }
    a { color: #22c55e; }
  </style>
</head>
<body>
  <h1>🔑 FlipRadar — Vinted Token</h1>
  <div class="status-badge ${minsLeft > 0 ? 'active' : 'expired'}">
    ${minsLeft > 0 ? '✅ Active — ' + minsLeft + ' mins remaining' : '❌ Expired — scanning paused'}
  </div>

  <div class="steps">
    <div class="step"><div class="num">1</div><p>Open <a href="https://www.vinted.co.uk" target="_blank">vinted.co.uk</a> and make sure you're logged in</p></div>
    <div class="step"><div class="num">2</div><p>Press <strong>F12</strong> → click <strong>Application</strong> tab → <strong>Cookies</strong> → <strong>www.vinted.co.uk</strong></p></div>
    <div class="step"><div class="num">3</div><p>Find <code>access_token_web</code> → copy value. Then find <code>refresh_token_web</code> → copy that too.</p></div>
    <div class="step"><div class="num">4</div><p>Paste both below. With the refresh token, FlipRadar <strong>auto-renews silently</strong> — you won't need to do this again for days.</p></div>
  </div>

  <label style="color:#aaa;font-size:13px;">access_token_web <span style="color:#22c55e">(required)</span></label>
  <textarea id="tokenInput" placeholder="eyJraWQiOiJ... (paste access_token_web here)"></textarea>
  <label style="color:#aaa;font-size:13px;margin-top:8px;display:block;">refresh_token_web <span style="color:#888">(optional — enables auto-refresh)</span></label>
  <textarea id="refreshInput" placeholder="paste refresh_token_web here (optional but recommended)"></textarea>
  <button onclick="saveToken()">Save Tokens & Resume Scanning</button>
  <div id="result"></div>

  <script>
    async function saveToken() {
      const token = document.getElementById('tokenInput').value.trim();
      const resultEl = document.getElementById('result');
      resultEl.style.display = 'block';
      resultEl.className = '';
      resultEl.textContent = 'Saving...';
      if (!token || !token.includes('.')) {
        resultEl.className = 'err';
        resultEl.textContent = '❌ That does not look like a valid token. Make sure you copied access_token_web, not the session cookie.';
        return;
      }
      try {
        const refreshToken = document.getElementById('refreshInput').value.trim();
        const resp = await fetch('/set-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, refreshToken: refreshToken || null })
        });
        const data = await resp.json();
        if (data.ok) {
          resultEl.className = 'ok';
          resultEl.textContent = data.autoRefresh
            ? '✅ Tokens saved with auto-refresh! FlipRadar will renew silently — no more manual refreshes needed for days.'
            : '✅ Token saved! Valid for ' + data.minsLeft + ' minutes. Vinted scanning resumed.';
          document.getElementById('tokenInput').value = '';
          document.getElementById('refreshInput').value = '';
        } else {
          resultEl.className = 'err';
          resultEl.textContent = '❌ ' + (data.error || 'Unknown error');
        }
      } catch(e) {
        resultEl.className = 'err';
        resultEl.textContent = '❌ Network error: ' + e.message;
      }
    }
  </script>
</body>
</html>`);
});

// Token set endpoint — called by /refresh-token page
app.post('/set-token', express.json(), (req, res) => {
  const { token, refreshToken } = req.body || {};
  if (!token) return res.json({ ok: false, error: 'No token provided' });
  const result = setVintedToken(token, refreshToken);
  if (result.ok) {
    const msg = result.autoRefresh
      ? '✅ <b>Vinted token set with auto-refresh!</b> Valid for ' + result.minsLeft + ' mins, then renews silently.'
      : '✅ <b>Vinted token refreshed!</b> Valid for ' + result.minsLeft + ' mins. Scanning resumed.';
    sendTelegram(msg).catch(() => {});
  }
  res.json(result);
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

app.get('/status', (req, res) => {
  const now = Date.now();
  const uptimeMs = now - new Date(statusData.startedAt).getTime();
  const uptimeHrs = Math.floor(uptimeMs / 3600000);
  const uptimeMins = Math.floor((uptimeMs % 3600000) / 60000);

  const timeSince = (iso) => {
    if (!iso) return 'Never';
    const diff = Math.floor((now - new Date(iso).getTime()) / 60000);
    if (diff < 1) return 'Just now';
    if (diff < 60) return diff + 'm ago';
    return Math.floor(diff / 60) + 'h ' + (diff % 60) + 'm ago';
  };

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="refresh" content="60">
  <title>FlipRadar Status</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f0f; color: #fff; min-height: 100vh; padding: 24px; }
    h1 { font-size: 22px; font-weight: 700; margin-bottom: 4px; }
    .subtitle { color: #666; font-size: 13px; margin-bottom: 24px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-bottom: 24px; }
    .card { background: #1a1a1a; border-radius: 12px; padding: 16px; border: 1px solid #2a2a2a; }
    .card-label { font-size: 11px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; }
    .card-value { font-size: 22px; font-weight: 700; }
    .card-sub { font-size: 12px; color: #666; margin-top: 4px; }
    .status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
    .green { background: #22c55e; box-shadow: 0 0 8px #22c55e; }
    .yellow { background: #eab308; }
    .section-title { font-size: 13px; font-weight: 600; color: #888; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px; }
    .deal { background: #1a1a1a; border-radius: 10px; padding: 14px; margin-bottom: 8px; border: 1px solid #2a2a2a; display: flex; justify-content: space-between; align-items: center; }
    .deal-title { font-size: 14px; font-weight: 500; }
    .deal-meta { font-size: 12px; color: #666; margin-top: 3px; }
    .badge { font-size: 11px; font-weight: 600; padding: 3px 8px; border-radius: 20px; white-space: nowrap; }
    .mustbuy { background: #166534; color: #4ade80; }
    .strong { background: #1e3a5f; color: #60a5fa; }
    .vinted { background: #3b1f5e; color: #c084fc; }
    .profit { font-size: 16px; font-weight: 700; color: #4ade80; }
    .footer { text-align: center; color: #444; font-size: 12px; margin-top: 24px; }
    .actions { display: flex; gap: 8px; margin-bottom: 24px; }
    .btn { background: #1a1a1a; border: 1px solid #2a2a2a; color: #fff; padding: 8px 16px; border-radius: 8px; font-size: 13px; cursor: pointer; text-decoration: none; }
    .btn:hover { border-color: #444; }
    .btn-primary { background: #166534; border-color: #166534; }
  </style>
</head>
<body>
  <h1>🎯 FlipRadar</h1>
  <p class="subtitle">Auto-refreshes every 60 seconds</p>

  <div class="grid">
    <div class="card">
      <div class="card-label">Status</div>
      <div class="card-value"><span class="status-dot green"></span>Live</div>
      <div class="card-sub">Up ${uptimeHrs}h ${uptimeMins}m</div>
    </div>
    <div class="card">
      <div class="card-label">Last eBay Scan</div>
      <div class="card-value">${timeSince(statusData.lastEbayScan)}</div>
      <div class="card-sub">Every 60 minutes</div>
    </div>
    <div class="card">
      <div class="card-label">Last Vinted Scan</div>
      <div class="card-value">${timeSince(statusData.lastVintedScan)}</div>
      <div class="card-sub">Every 5 minutes</div>
    </div>
    <div class="card">
      <div class="card-label">Last Email</div>
      <div class="card-value">${timeSince(statusData.lastEmailSent)}</div>
      <div class="card-sub">${statusData.totalEmailsSent} sent this session</div>
    </div>
    <div class="card">
      <div class="card-label">eBay Queue</div>
      <div class="card-value">${QUEUE.length}</div>
      <div class="card-sub">Searches per scan</div>
    </div>
    <div class="card">
      <div class="card-label">Alerted IDs</div>
      <div class="card-value">${alertedIds.size}</div>
      <div class="card-sub">Tracked this session</div>
    </div>
  </div>

  <div class="actions">
    <a href="/scan" class="btn btn-primary">▶ Run eBay Scan</a>
    <a href="/scan-vinted" class="btn">🔍 Run Vinted Scan</a>
    <a href="/health" class="btn">❤ Health</a>
  </div>

  <div class="section-title">Last Deals Alerted</div>
  ${statusData.lastDeals.length === 0
    ? '<div class="card" style="color:#666">No deals alerted yet this session</div>'
    : statusData.lastDeals.map(d => `
    <div class="deal">
      <div>
        <div class="deal-title">${d.title}</div>
        <div class="deal-meta">£${d.price} buy · ${d.source}</div>
      </div>
      <div style="text-align:right">
        <div class="profit">+£${d.profit}</div>
        <span class="badge ${d.source === 'Vinted' ? 'vinted' : d.tier}">${d.tier === 'mustbuy' ? 'Must Buy' : 'Strong'}</span>
      </div>
    </div>`).join('')}

  <div class="footer">FlipRadar · Max buy £${MAX_BUY_PRICE} · ${new Date().toLocaleString('en-GB')}</div>
</body>
</html>`;
  res.send(html);
});

app.get('/scan-vinted', (req, res) => {
  res.json({ message: 'Vinted scan started — check logs and email in ~10 minutes' });
  runVintedScan();
});

app.listen(process.env.PORT || 3000, () => {
  console.log('FlipRadar bot running');
  console.log('Alert email: ' + (ALERT_EMAIL || 'NOT SET'));
  console.log('Email service: ' + (SENDGRID_KEY ? 'SendGrid ready' : 'NOT SET'));
  console.log('Queue: ' + QUEUE.length + ' searches');
  console.log('Max buy price: £' + MAX_BUY_PRICE);

  // Load Vinted refresh token from env on startup — survives Render restarts
  if (process.env.VINTED_REFRESH_TOKEN) {
    vintedRefreshToken = process.env.VINTED_REFRESH_TOKEN;
    console.log('Vinted: refresh token loaded from env — will auto-fetch access token on first scan');
  }

  // Stagger startup to avoid overlap with any dying instance
  const startDelay = 30000 + Math.floor(Math.random() * 15000);
  setTimeout(scheduledScan, startDelay);
  setTimeout(scheduledVintedScan, 60000);

  // Keep-alive ping every 10 minutes to prevent Render free tier sleep
  setInterval(() => {
    fetch('https://flipradar-proxy.onrender.com/health')
      .then(() => console.log('Keep-alive ping sent'))
      .catch(() => {});
  }, 10 * 60 * 1000);
});
