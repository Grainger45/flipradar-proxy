// FlipRadar - server.js (Fixed - Vinted removed, email fixed)
// ENV VARS: EBAY_APP_ID, ANTHROPIC_API_KEY, SENDGRID_API_KEY or RESEND_API_KEY, ALERT_EMAIL

const express = require('express');
const https = require('https');
const http = require('http');
const app = express();
app.use(express.json());

// ── Config ────────────────────────────────────────────────────
const POSTAGE = 3.50;
const MAX_BUY = parseFloat(process.env.MAX_BUY_PRICE || '20');
const ALERT_EMAIL = process.env.ALERT_EMAIL || 'l.grainger1996@gmail.com';
const MIN_PROFIT = parseFloat(process.env.MIN_PROFIT || '10');

// ── State ─────────────────────────────────────────────────────
let lastEbayScan = null;
let alertedIds = new Set();
let alertedCount = 0;
let scanCount = 0;
let lastDealsAlerted = [];

// ── Brand pricing (Vinted UK sell-through data) ───────────────
const BRAND_PRICING = {
  'Nike': [2.8, 2.2], 'Adidas': [2.5, 2.0], 'Ralph Lauren': [2.6, 2.0],
  'Tommy Hilfiger': [2.4, 1.9], 'Lacoste': [2.5, 2.0], 'Stone Island': [3.0, 2.5],
  'Stone Island Junior': [2.8, 2.2], 'CP Company': [2.8, 2.3], 'CP Company Junior': [2.6, 2.1],
  'Moncler': [3.2, 2.6], 'Moncler Kids': [3.0, 2.4], 'Burberry': [2.8, 2.2],
  "Levi's": [2.4, 1.9], 'Carhartt': [2.5, 2.0], 'North Face': [2.6, 2.1],
  'Patagonia': [2.8, 2.2], 'Barbour': [3.0, 2.4], 'New Balance': [2.6, 2.1],
  'Gymshark': [2.4, 1.9], 'Champion': [2.3, 1.8], 'default': [1.8, 1.5]
};

function getPricing(brand) {
  for (const [k, v] of Object.entries(BRAND_PRICING)) {
    if (brand && brand.toLowerCase().includes(k.toLowerCase())) return v;
  }
  return BRAND_PRICING['default'];
}

// ── Search queue ──────────────────────────────────────────────
const QUEUE = [
  { q: 'Nike vintage hoodie sweatshirt', brand: 'Nike', avgSell: 45, cat: 'nike' },
  { q: 'Nike tracksuit bottoms vintage', brand: 'Nike', avgSell: 35, cat: 'nike' },
  { q: 'Adidas hoodie sweatshirt vintage', brand: 'Adidas', avgSell: 38, cat: 'adidas' },
  { q: 'Ralph Lauren polo shirt mens', brand: 'Ralph Lauren', avgSell: 35, cat: 'polo' },
  { q: 'Ralph Lauren hoodie sweatshirt', brand: 'Ralph Lauren', avgSell: 45, cat: 'polo' },
  { q: 'Tommy Hilfiger polo shirt', brand: 'Tommy Hilfiger', avgSell: 32, cat: 'polo' },
  { q: 'Lacoste polo shirt mens', brand: 'Lacoste', avgSell: 38, cat: 'polo' },
  { q: "Levi 501 jeans vintage", brand: "Levi's", avgSell: 45, cat: 'vintage' },
  { q: 'New Balance trainers 990 991', brand: 'New Balance', avgSell: 85, cat: 'trainers' },
  { q: 'North Face fleece jacket', brand: 'North Face', avgSell: 55, cat: 'outdoor' },
  { q: 'Patagonia fleece pullover half zip', brand: 'Patagonia', avgSell: 65, cat: 'outdoor' },
  { q: 'Carhartt jacket work coat', brand: 'Carhartt', avgSell: 50, cat: 'vintage' },
  { q: 'Champion reverse weave hoodie', brand: 'Champion', avgSell: 40, cat: 'vintage' },
  { q: 'Stone Island Junior jacket boys', brand: 'Stone Island Junior', avgSell: 85, cat: 'kids' },
  { q: 'CP Company Junior jacket kids', brand: 'CP Company Junior', avgSell: 75, cat: 'kids' },
  { q: 'Moncler kids jacket boys girls', brand: 'Moncler Kids', avgSell: 110, cat: 'kids' },
  { q: 'Barbour wax jacket vintage', brand: 'Barbour', avgSell: 80, cat: 'vintage' },
  { q: 'football shirt loft find old rare', brand: 'Football', avgSell: 50, cat: 'football' },
  { q: 'Parma Fiorentina Sampdoria shirt', brand: 'Football', avgSell: 65, cat: 'football' },
  { q: 'vintage jacket loft find clearance', brand: 'Various', avgSell: 40, cat: 'unknown' },
  // Misspellings
  { q: 'Raplh Lauren polo shirt', brand: 'Ralph Lauren', avgSell: 35, cat: 'typo' },
  { q: 'Addidas hoodie vintage', brand: 'Adidas', avgSell: 38, cat: 'typo' },
  { q: 'Niike hoodie vintage', brand: 'Nike', avgSell: 45, cat: 'typo' },
  { q: 'Patogonia fleece jacket', brand: 'Patagonia', avgSell: 65, cat: 'typo' },
  { q: 'Chamion reverse weave hoodie', brand: 'Champion', avgSell: 40, cat: 'typo' },
];

// ── Fetch helper ──────────────────────────────────────────────
function fetchUrl(url, options = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', ...options.headers },
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

// ── eBay search ───────────────────────────────────────────────
async function searchEbay(item) {
  try {
    const maxPrice = Math.floor(item.avgSell / 2); // only buy if under 50% of avg sell
    const params = new URLSearchParams({
      'OPERATION-NAME': 'findItemsAdvanced',
      'SERVICE-VERSION': '1.13.0',
      'SECURITY-APPNAME': process.env.EBAY_APP_ID,
      'RESPONSE-DATA-FORMAT': 'JSON',
      'keywords': item.q,
      'paginationInput.entriesPerPage': '20',
      'itemFilter(0).name': 'MaxPrice',
      'itemFilter(0).value': Math.min(maxPrice, MAX_BUY),
      'itemFilter(0).paramName': 'Currency',
      'itemFilter(0).paramValue': 'GBP',
      'itemFilter(1).name': 'MinPrice',
      'itemFilter(1).value': '2',
      'itemFilter(2).name': 'ListingType',
      'itemFilter(2).value': 'FixedPrice',
      'itemFilter(3).name': 'Condition',
      'itemFilter(3).value': 'Used',
      'itemFilter(4).name': 'LocatedIn',
      'itemFilter(4).value': 'GB',
      'sortOrder': 'StartTimeNewest',
    });

    const data = await fetchUrl(`https://svcs.ebay.com/services/search/FindingService/v1?${params}`);
    const parsed = JSON.parse(data);
    const items = parsed?.findItemsAdvancedResponse?.[0]?.searchResult?.[0]?.item || [];

    const deals = [];
    for (const ebayItem of items) {
      try {
        const price = parseFloat(ebayItem.sellingStatus?.[0]?.currentPrice?.[0]?.['__value__'] || '0');
        if (price < 2 || price > MAX_BUY) continue;

        const title = ebayItem.title?.[0] || '';
        const itemId = ebayItem.itemId?.[0] || '';
        const url = ebayItem.viewItemURL?.[0] || '';
        const image = ebayItem.galleryURL?.[0] || '';

        // Calculate profit
        const [vintedMult, ebayMult] = getPricing(item.brand);
        const vintedList = Math.round(price * vintedMult);
        const ebayList = Math.round(price * ebayMult);
        const vintedNet = Math.round((vintedList - price - POSTAGE) * 100) / 100;
        const ebayNet = Math.round(((ebayList * 0.87) - price - POSTAGE) * 100) / 100;
        const bestNet = Math.max(vintedNet, ebayNet);
        const bestPlatform = vintedNet >= ebayNet ? 'Vinted' : 'eBay';
        const roi = Math.round((bestNet / price) * 100);

        if (bestNet < MIN_PROFIT) continue;

        // Confidence tier
        let tier = 'possible';
        if (roi >= 150 && bestNet >= 15) tier = 'mustbuy';
        else if (roi >= 100 && bestNet >= 10) tier = 'strong';

        deals.push({
          id: itemId, title, price, url, image,
          brand: item.brand, cat: item.cat,
          vintedListPrice: vintedList, ebayListPrice: ebayList,
          vintedNet, ebayNet, bestNet, netProfit: bestNet,
          bestPlatform, roi, confidenceTier: tier,
          source: 'eBay'
        });
      } catch(e) { /* skip bad items */ }
    }
    return deals;
  } catch(e) {
    console.error(`eBay error (${item.q}):`, e.message);
    return [];
  }
}

// ── Email ─────────────────────────────────────────────────────
async function sendEmail(subject, html) {
  // Try Resend first, fall back to SendGrid
  if (process.env.RESEND_API_KEY) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.RESEND_API_KEY}` },
      body: JSON.stringify({ from: 'FlipRadar <onboarding@resend.dev>', to: [ALERT_EMAIL], subject, html })
    });
    if (res.ok) { console.log('Email sent via Resend'); return true; }
    console.error('Resend failed:', await res.text());
  }
  if (process.env.SENDGRID_API_KEY) {
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.SENDGRID_API_KEY}` },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: ALERT_EMAIL }] }],
        from: { email: process.env.FROM_EMAIL || ALERT_EMAIL, name: 'FlipRadar' },
        subject, content: [{ type: 'text/html', value: html }]
      })
    });
    if (res.ok) { console.log('Email sent via SendGrid'); return true; }
    console.error('SendGrid failed:', await res.text());
  }
  console.error('No email provider configured');
  return false;
}

async function sendDealAlert(deals) {
  if (!deals.length) return;

  const cards = deals.map(d => `
    <div style="border:1px solid #e5e7eb;border-radius:12px;padding:16px;margin-bottom:12px;font-family:sans-serif;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;">
        <div style="flex:1;">
          ${d.image ? `<img src="${d.image}" style="width:80px;height:80px;object-fit:cover;border-radius:8px;float:right;margin-left:12px;" />` : ''}
          <div style="margin-bottom:6px;">
            <span style="background:${d.confidenceTier==='mustbuy'?'#EAF3DE':d.confidenceTier==='strong'?'#FAEEDA':'#f3f4f6'};
                         color:${d.confidenceTier==='mustbuy'?'#3B6D11':d.confidenceTier==='strong'?'#854F0B':'#6b7280'};
                         font-size:11px;font-weight:600;padding:3px 10px;border-radius:20px;">
              ${d.confidenceTier==='mustbuy'?'🎯 Must Buy':d.confidenceTier==='strong'?'⚡ Strong':'✓ Possible'}
            </span>
          </div>
          <p style="font-size:15px;font-weight:600;margin:0 0 4px;color:#111;">${d.title}</p>
          <p style="font-size:13px;color:#6b7280;margin:0 0 8px;">${d.brand} · ${d.cat}</p>
          <div style="display:flex;gap:16px;margin-bottom:10px;">
            <div><div style="font-size:11px;color:#9ca3af;">Buy for</div><div style="font-size:18px;font-weight:700;color:#111;">£${d.price.toFixed(0)}</div></div>
            <div><div style="font-size:11px;color:#9ca3af;">List on ${d.bestPlatform}</div><div style="font-size:18px;font-weight:700;color:#111;">£${d.bestPlatform==='Vinted'?d.vintedListPrice:d.ebayListPrice}</div></div>
            <div><div style="font-size:11px;color:#9ca3af;">Net profit</div><div style="font-size:18px;font-weight:700;color:#22c55e;">+£${d.bestNet.toFixed(0)}</div></div>
            <div><div style="font-size:11px;color:#9ca3af;">ROI</div><div style="font-size:18px;font-weight:700;color:#2563eb;">${d.roi}%</div></div>
          </div>
          <a href="${d.url}" style="background:#111;color:#fff;padding:8px 20px;border-radius:8px;font-size:13px;font-weight:600;text-decoration:none;display:inline-block;">View on eBay →</a>
          <a href="https://www.vinted.co.uk/catalog?search_text=${encodeURIComponent(d.title)}&order=relevance" style="background:#EAF3DE;color:#3B6D11;padding:8px 16px;border-radius:8px;font-size:13px;font-weight:600;text-decoration:none;display:inline-block;margin-left:8px;">Check Vinted prices →</a>
        </div>
      </div>
    </div>`).join('');

  const html = `
    <div style="max-width:620px;margin:0 auto;padding:20px;font-family:sans-serif;">
      <h1 style="font-size:22px;font-weight:700;color:#111;margin:0 0 4px;">🔥 FlipRadar: ${deals.length} deal${deals.length>1?'s':''} found</h1>
      <p style="color:#6b7280;font-size:13px;margin:0 0 20px;">${new Date().toLocaleString('en-GB')} · Buy under £${MAX_BUY} · Min £${MIN_PROFIT} profit</p>
      ${cards}
      <p style="font-size:11px;color:#d1d5db;text-align:center;margin-top:16px;">FlipRadar · eBay UK scanner · Vinted arbitrage</p>
    </div>`;

  await sendEmail(`🔥 FlipRadar: ${deals.length} must-buy deal${deals.length>1?'s':''} found — ${new Date().toLocaleDateString('en-GB')}`, html);
}

// ── Main eBay scan ─────────────────────────────────────────────
let qIdx = 0;
async function runEbayScan() {
  console.log(`[${new Date().toISOString()}] Running eBay scan...`);
  const batch = [];
  for (let i = 0; i < 5; i++) batch.push(QUEUE[(qIdx + i) % QUEUE.length]);
  qIdx = (qIdx + 5) % QUEUE.length;

  const newDeals = [];
  for (const item of batch) {
    const deals = await searchEbay(item);
    for (const deal of deals) {
      if (!alertedIds.has(deal.id)) {
        newDeals.push(deal);
      }
    }
    await sleep(500);
  }

  scanCount += batch.length;
  lastEbayScan = new Date();

  // Filter to strong/mustbuy only for email
  const emailDeals = newDeals.filter(d => d.confidenceTier === 'mustbuy' || d.confidenceTier === 'strong');

  if (emailDeals.length > 0) {
    console.log(`Found ${emailDeals.length} strong deals — sending email`);
    emailDeals.forEach(d => alertedIds.add(d.id));
    alertedCount += emailDeals.length;
    lastDealsAlerted = emailDeals.map(d => `${d.title} (£${d.price} → +£${d.bestNet.toFixed(0)})`);
    await sendDealAlert(emailDeals);
  } else {
    console.log(`Scan complete — ${newDeals.length} deals found, none strong enough to alert`);
  }
}

// ── Schedule eBay scan every 10 minutes ───────────────────────
function scheduleScan() {
  runEbayScan();
  setInterval(runEbayScan, 10 * 60 * 1000);
  console.log('eBay scan scheduled every 10 minutes');
}

// ── Routes ─────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({
  status: 'ok', botRunning: true, alertEmail: ALERT_EMAIL,
  emailReady: !!(process.env.RESEND_API_KEY || process.env.SENDGRID_API_KEY),
  maxBuyPrice: MAX_BUY, minProfit: MIN_PROFIT,
  queueSize: QUEUE.length, alertedSoFar: alertedCount
}));

app.get('/status', (_, res) => res.send(`
  <html><head><meta http-equiv="refresh" content="60"><title>FlipRadar Status</title></head>
  <body style="font-family:sans-serif;max-width:500px;margin:40px auto;padding:20px;">
    <h2>🎯 FlipRadar</h2>
    <p><strong>Status:</strong> Live ✅</p>
    <p><strong>Last eBay Scan:</strong> ${lastEbayScan ? lastEbayScan.toLocaleString('en-GB') : 'Not yet'}</p>
    <p><strong>Scans run:</strong> ${scanCount} search batches</p>
    <p><strong>Deals alerted:</strong> ${alertedCount}</p>
    <p><strong>Email provider:</strong> ${process.env.RESEND_API_KEY ? 'Resend ✅' : process.env.SENDGRID_API_KEY ? 'SendGrid' : '❌ None configured'}</p>
    <p><strong>Max buy price:</strong> £${MAX_BUY}</p>
    <p><strong>Min profit:</strong> £${MIN_PROFIT}</p>
    <p><strong>Last deals alerted:</strong><br>${lastDealsAlerted.length ? lastDealsAlerted.join('<br>') : 'None yet this session'}</p>
    <hr>
    <p><a href="/scan">▶ Run scan now</a> | <a href="/test-email">📧 Test email</a> | <a href="/health">Health JSON</a></p>
    <p style="color:#9ca3af;font-size:12px;">FlipRadar · No Vinted scanning · eBay only · ${new Date().toLocaleString('en-GB')}</p>
  </body></html>
`));

app.get('/deals', async (req, res) => {
  const { q, minPrice, maxPrice, avgSell, cat, brand } = req.query;
  if (!q) return res.json({ deals: [] });
  const item = { q, avgSell: parseFloat(avgSell || '40'), cat: cat || 'unknown', brand: brand || 'Various' };
  const deals = await searchEbay(item);
  res.json({ deals });
});

app.get('/scan', async (req, res) => {
  res.send('Scan triggered — check email in ~2 mins and /status for results.');
  runEbayScan();
});

app.get('/test-email', async (req, res) => {
  const ok = await sendEmail('✅ FlipRadar email test', '<p>Email is working! FlipRadar will alert you when strong deals are found.</p>');
  res.send(ok ? '✅ Test email sent — check your inbox.' : '❌ Email failed — check API keys in Render environment vars.');
});

app.get('/ping', (_, res) => res.send('pong'));

// ── Start ──────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FlipRadar running on port ${PORT}`);
  console.log(`Alert email: ${ALERT_EMAIL}`);
  console.log(`Max buy: £${MAX_BUY}, Min profit: £${MIN_PROFIT}`);
  console.log('Vinted scanning: DISABLED');
  scheduleScan();
});
