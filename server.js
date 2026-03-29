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
const ALERT_EMAIL = process.env.ALERT_EMAIL; // Your email address
const FROM_EMAIL = process.env.FROM_EMAIL || 'flipradar@alerts.com';
const MIN_NET_PROFIT = 10;
const POSTAGE = 3.50;
const MUST_BUY_THRESHOLD = 0.45; // Item priced below 45% of market median = Must Buy
const STRONG_THRESHOLD = 0.65;   // Below 65% = Strong

// ── SEARCH QUEUE — proven Vinted UK sellers ──
const QUEUE = [
  {q:'Nike vintage hoodie sweatshirt',brand:'Nike',avgSell:42,vintedQ:'Nike vintage hoodie'},
  {q:'Nike hoodie retro old',brand:'Nike',avgSell:38,vintedQ:'Nike hoodie'},
  {q:'Adidas hoodie sweatshirt vintage',brand:'Adidas',avgSell:35,vintedQ:'Adidas hoodie'},
  {q:'Adidas tracksuit top vintage',brand:'Adidas',avgSell:32,vintedQ:'Adidas tracksuit top'},
  {q:'Ralph Lauren polo shirt mens',brand:'Ralph Lauren',avgSell:32,vintedQ:'Ralph Lauren polo'},
  {q:'Ralph Lauren hoodie sweatshirt',brand:'Ralph Lauren',avgSell:42,vintedQ:'Ralph Lauren hoodie'},
  {q:'Tommy Hilfiger polo shirt mens',brand:'Tommy Hilfiger',avgSell:30,vintedQ:'Tommy Hilfiger polo'},
  {q:'Lacoste polo shirt mens',brand:'Lacoste',avgSell:35,vintedQ:'Lacoste polo'},
  {q:'Levi 501 jeans vintage',brand:"Levi's",avgSell:42,vintedQ:"Levi's 501 jeans"},
  {q:'North Face fleece jacket',brand:'North Face',avgSell:52,vintedQ:'North Face fleece'},
  {q:'Patagonia fleece half zip',brand:'Patagonia',avgSell:62,vintedQ:'Patagonia fleece'},
  {q:'Carhartt jacket coat',brand:'Carhartt',avgSell:48,vintedQ:'Carhartt jacket'},
  {q:'Champion reverse weave hoodie',brand:'Champion',avgSell:38,vintedQ:'Champion hoodie'},
  {q:'Barbour wax jacket',brand:'Barbour',avgSell:75,vintedQ:'Barbour wax jacket'},
  {q:'Stone Island Junior jacket boys',brand:'Stone Island Junior',avgSell:80,vintedQ:'Stone Island Junior'},
  {q:'CP Company Junior jacket boys',brand:'CP Company Junior',avgSell:70,vintedQ:'CP Company Junior'},
  {q:'Moncler kids jacket boys',brand:'Moncler Kids',avgSell:105,vintedQ:'Moncler kids jacket'},
  {q:'Nike kids jacket boys',brand:'Nike',avgSell:28,vintedQ:'Nike kids jacket'},
  {q:'Adidas kids tracksuit boys',brand:'Adidas',avgSell:26,vintedQ:'Adidas kids tracksuit'},
  {q:'vintage jacket loft find clearance',brand:'Various',avgSell:38,vintedQ:'vintage jacket'},
  {q:'old branded jacket house clearance',brand:'Various',avgSell:35,vintedQ:'branded jacket'},
  {q:'Moschino vintage top jacket',brand:'Moschino',avgSell:58,vintedQ:'Moschino vintage'},
  {q:'Versace jeans couture vintage',brand:'Versace Jeans',avgSell:62,vintedQ:'Versace Jeans Couture'},
  {q:'Parma Fiorentina Sampdoria shirt',brand:'Serie A',avgSell:62,vintedQ:'Serie A football shirt'},
  {q:'football shirt loft find old rare',brand:'Football Shirt',avgSell:48,vintedQ:'vintage football shirt'},
  // Misspellings
  {q:'Raplh Lauren polo shirt',brand:'Ralph Lauren',avgSell:32,vintedQ:'Ralph Lauren polo'},
  {q:'Addidas hoodie vintage',brand:'Adidas',avgSell:35,vintedQ:'Adidas hoodie'},
  {q:'Niike hoodie vintage',brand:'Nike',avgSell:42,vintedQ:'Nike hoodie'},
  {q:'Patogonia fleece jacket',brand:'Patagonia',avgSell:62,vintedQ:'Patagonia fleece'},
  {q:'Barbour wax jakcet',brand:'Barbour',avgSell:75,vintedQ:'Barbour wax jacket'},
];

// Brand multipliers for Vinted pricing (from real market research)
const BRAND_MULTIPLIERS = {
  'Nike': 2.8, 'Adidas': 2.5, 'Ralph Lauren': 2.6, 'Tommy Hilfiger': 2.4,
  'Lacoste': 2.5, 'Stone Island': 3.0, 'Stone Island Junior': 2.8,
  'CP Company Junior': 2.6, 'Moncler Kids': 3.0, 'Barbour': 3.0,
  'Patagonia': 2.8, 'North Face': 2.6, 'Carhartt': 2.5,
  'Champion': 2.3, "Levi's": 2.4, 'Moschino': 2.6, 'Versace Jeans': 2.6,
  'default': 1.9
};

function getVintedMultiplier(brand) {
  for (const [key, val] of Object.entries(BRAND_MULTIPLIERS)) {
    if (brand && brand.toLowerCase().includes(key.toLowerCase())) return val;
  }
  return BRAND_MULTIPLIERS['default'];
}

const HARD_REJECT = [
  'reproduction','replica','remake','bootleg','badge','pin','pennant',
  'programme','program','scarf','poster','mug','sticker','patch',
  'keyring','book','magazine','dvd','photo','trading card','ticket',
  'figurine','dirty','heavily worn','major stain','ripped','torn'
];
const COND_WARN = ['stain','mark','faded','damage','repair','hole','smell','fault','as seen','as is','worn','well worn','tatty','grubby'];

let cachedToken = null;
let tokenExpiry = 0;
const alertedIds = new Set(); // Prevent duplicate alerts

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

// Get real eBay UK market prices with outlier removal
async function getMarketPrices(query, token) {
  try {
    const q = encodeURIComponent(query);
    const url = 'https://api.ebay.com/buy/browse/v1/item_summary/search?q=' + q +
      '&limit=40&marketplace_ids=EBAY_GB&filter=itemLocationCountry:GB,buyingOptions:{FIXED_PRICE}&sort=endDateSoonest';
    const r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_GB' } });
    const data = await r.json();
    const items = (data.itemSummaries || []).filter(i => !shouldReject(i));
    if (!items.length) return null;

    const prices = items.map(i => parseFloat(i.price?.value || 0)).filter(p => p > 2).sort((a, b) => a - b);
    if (prices.length < 5) return null;

    const trimmed = prices.slice(Math.floor(prices.length * 0.25), Math.ceil(prices.length * 0.75));
    if (!trimmed.length) return null;

    const median = trimmed[Math.floor(trimmed.length / 2)];
    const low = trimmed[0];
    const high = trimmed[trimmed.length - 1];

    return { median, low, high, sampleSize: prices.length, trimmedSize: trimmed.length };
  } catch (e) { return null; }
}

// Score a deal and determine confidence
function scoreDeal(item, marketData, brand, avgSell) {
  const price = parseFloat(item.price?.value || item.price || 0);
  if (price <= 0) return null;

  const title = item.title || '';
  const titleLower = title.toLowerCase();
  const hasCondWarn = COND_WARN.some(w => titleLower.includes(w));

  // Calculate estimated Vinted sell price
  const multiplier = getVintedMultiplier(brand);
  const estimatedSell = marketData ? marketData.median * multiplier / 1.5 : avgSell;
  const vintedListPrice = marketData
    ? Math.round(marketData.median * (multiplier > 2.5 ? 1.1 : 1.0))
    : Math.round(avgSell * multiplier / 1.5);

  const vintedNet = vintedListPrice - price - POSTAGE;
  if (vintedNet < MIN_NET_PROFIT) return null;
  if (hasCondWarn && vintedNet < 20) return null; // Stricter on damaged items

  // Confidence tier based on real market data
  let confidenceTier = 'possible';
  let confidenceScore = 0;
  let confidenceReasons = [];

  if (marketData && marketData.sampleSize >= 5) {
    const ratio = price / marketData.median;

    if (ratio <= MUST_BUY_THRESHOLD && !hasCondWarn) {
      confidenceTier = 'mustbuy';
      confidenceScore = 95;
      confidenceReasons.push('Priced at ' + Math.round(ratio * 100) + '% of market median (£' + marketData.median + ')');
      confidenceReasons.push('Based on ' + marketData.sampleSize + ' real UK eBay listings');
    } else if (ratio <= STRONG_THRESHOLD) {
      confidenceTier = 'strong';
      confidenceScore = 75;
      confidenceReasons.push('Priced at ' + Math.round(ratio * 100) + '% of market median');
      confidenceReasons.push('Market range: £' + marketData.low + '–£' + marketData.high);
    } else {
      confidenceTier = 'possible';
      confidenceScore = 50;
      confidenceReasons.push('Market data available but margin is tighter');
    }
  } else {
    confidenceTier = 'possible';
    confidenceScore = 35;
    confidenceReasons.push('No real market data — estimate only');
  }

  // Boost score for great condition signals
  if (titleLower.includes('bnwt') || titleLower.includes('unworn') || titleLower.includes('never worn')) {
    confidenceScore = Math.min(99, confidenceScore + 10);
    confidenceReasons.push('Unworn/BNWT — premium condition');
  }
  if (titleLower.includes('loft find') || titleLower.includes('house clearance')) {
    confidenceScore = Math.min(99, confidenceScore + 5);
    confidenceReasons.push('Loft find — seller likely unaware of value');
  }

  const roi = Math.round((vintedNet / price) * 100);

  return {
    id: item.itemId || item.id,
    title,
    price,
    url: item.itemWebUrl || item.url,
    image: item.image?.imageUrl || item.image,
    condition: item.condition,
    brand,
    vintedListPrice,
    vintedNet: Math.round(vintedNet * 100) / 100,
    roi,
    confidenceTier,
    confidenceScore,
    confidenceReasons,
    marketData,
    hasCondWarn
  };
}

// Send email alert via SendGrid
async function sendEmailAlert(deals) {
  if (!SENDGRID_KEY || !ALERT_EMAIL) {
    console.log('No email config — skipping alert. Set SENDGRID_API_KEY and ALERT_EMAIL in Render.');
    return;
  }

  const mustBuys = deals.filter(d => d.confidenceTier === 'mustbuy');
  const strong = deals.filter(d => d.confidenceTier === 'strong');

  const dealHtml = deals.map(d => `
    <div style="border:2px solid ${d.confidenceTier === 'mustbuy' ? '#16a34a' : d.confidenceTier === 'strong' ? '#2563eb' : '#d97706'};border-radius:10px;padding:16px;margin-bottom:16px;font-family:sans-serif;">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:${d.confidenceTier === 'mustbuy' ? '#16a34a' : d.confidenceTier === 'strong' ? '#2563eb' : '#d97706'};margin-bottom:6px;">
        ${d.confidenceTier === 'mustbuy' ? '🎯 MUST BUY' : d.confidenceTier === 'strong' ? '⚡ STRONG' : '✓ POSSIBLE'}
        ${d.confidenceTier === 'mustbuy' ? ' — Real market data confirms profit' : ''}
      </div>
      <div style="font-size:16px;font-weight:700;margin-bottom:8px;">${d.title}</div>
      <div style="display:flex;gap:20px;margin-bottom:10px;flex-wrap:wrap;">
        <div><div style="font-size:10px;color:#888;text-transform:uppercase;">Buy for</div><div style="font-size:22px;font-weight:700;">£${d.price}</div></div>
        <div><div style="font-size:10px;color:#888;text-transform:uppercase;">List on Vinted</div><div style="font-size:22px;font-weight:700;color:#0891b2;">£${d.vintedListPrice}</div></div>
        <div><div style="font-size:10px;color:#888;text-transform:uppercase;">Net profit</div><div style="font-size:22px;font-weight:700;color:#16a34a;">+£${d.vintedNet}</div></div>
        <div><div style="font-size:10px;color:#888;text-transform:uppercase;">ROI</div><div style="font-size:22px;font-weight:700;">${d.roi}%</div></div>
      </div>
      ${d.marketData ? `
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:8px 12px;margin-bottom:10px;font-size:12px;font-family:monospace;">
        📊 Real eBay UK data: ${d.marketData.sampleSize} listings · Median £${d.marketData.median} · Range £${d.marketData.low}–£${d.marketData.high}
      </div>` : '<div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:6px;padding:8px 12px;margin-bottom:10px;font-size:12px;">⚠ No real market data — verify on Vinted before buying</div>'}
      <div style="margin-bottom:10px;">
        ${d.confidenceReasons.map(r => '<div style="font-size:12px;color:#444;margin-bottom:3px;">✓ ' + r + '</div>').join('')}
        ${d.hasCondWarn ? '<div style="font-size:12px;color:#dc2626;margin-bottom:3px;">⚠ Condition flag — check listing carefully</div>' : ''}
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <a href="${d.url}" style="background:#111;color:white;padding:8px 16px;border-radius:6px;text-decoration:none;font-size:13px;font-weight:600;">View on eBay →</a>
        <a href="https://www.vinted.co.uk/catalog?search_text=${encodeURIComponent(d.title)}&order=relevance" style="background:#0891b2;color:white;padding:8px 16px;border-radius:6px;text-decoration:none;font-size:13px;font-weight:600;">Check Vinted price</a>
        <a href="https://www.ebay.co.uk/sch/i.html?_nkw=${encodeURIComponent(d.title)}&LH_Complete=1&LH_Sold=1" style="background:#d97706;color:white;padding:8px 16px;border-radius:6px;text-decoration:none;font-size:13px;font-weight:600;">eBay Sold prices</a>
      </div>
    </div>
  `).join('');

  const subject = mustBuys.length > 0
    ? '🎯 ' + mustBuys.length + ' Must Buy deal' + (mustBuys.length > 1 ? 's' : '') + ' found — FlipRadar'
    : '⚡ ' + strong.length + ' strong deal' + (strong.length > 1 ? 's' : '') + ' found — FlipRadar';

  const html = `
    <div style="max-width:600px;margin:0 auto;font-family:sans-serif;background:#f7f7f5;padding:20px;">
      <div style="background:#111;color:white;padding:16px 20px;border-radius:10px;margin-bottom:20px;">
        <div style="font-size:20px;font-weight:700;margin-bottom:4px;">● FlipRadar Alert</div>
        <div style="font-size:13px;color:rgba(255,255,255,0.6);">${new Date().toLocaleString('en-GB')} · ${mustBuys.length} Must Buy · ${strong.length} Strong · ${deals.length - mustBuys.length - strong.length} Possible</div>
      </div>
      ${mustBuys.length > 0 ? '<div style="font-size:13px;color:#16a34a;font-weight:600;margin-bottom:12px;">🎯 Must Buy deals have real eBay market data confirming the item is priced well below market value. These are the ones to act on quickly.</div>' : ''}
      ${dealHtml}
      <div style="text-align:center;font-size:11px;color:#888;margin-top:20px;">FlipRadar · Always verify on Vinted before purchasing · Postage (£${POSTAGE}) already deducted from profit figures</div>
    </div>
  `;

  try {
    const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + SENDGRID_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: ALERT_EMAIL }] }],
        from: { email: FROM_EMAIL, name: 'FlipRadar' },
        subject,
        content: [{ type: 'text/html', value: html }]
      })
    });
    if (r.ok) {
      console.log('Alert email sent: ' + subject);
    } else {
      const err = await r.text();
      console.error('SendGrid error:', err);
    }
  } catch (e) {
    console.error('Email send failed:', e.message);
  }
}

// Main scan function — runs automatically
async function runScan() {
  const hour = new Date().getHours();
  if (hour >= 0 && hour < 7) {
    console.log('Night mode — skipping scan until 7am');
    return;
  }

  console.log('Starting scan at ' + new Date().toLocaleString('en-GB'));
  let token;
  try { token = await getToken(); } catch (e) { console.error('Token error:', e.message); return; }

  const alertDeals = [];

  for (const item of QUEUE) {
    try {
      const q = encodeURIComponent(item.q);
      const maxPrice = 15; // Max buy price

      // Fetch listings and market data in parallel
      const [ebayRes, marketData] = await Promise.all([
        fetch('https://api.ebay.com/buy/browse/v1/item_summary/search?q=' + q +
          '&limit=20&marketplace_ids=EBAY_GB' +
          '&filter=price:[0..' + maxPrice + '],priceCurrency:GBP,itemLocationCountry:GB' +
          '&sort=newlyListed', {
          headers: { 'Authorization': 'Bearer ' + token, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_GB' }
        }),
        getMarketPrices(item.vintedQ || item.q, token)
      ]);

      const ebayData = await ebayRes.json();
      const listings = (ebayData.itemSummaries || []).filter(l => !shouldReject(l)).slice(0, 10);

      for (const listing of listings) {
        if (alertedIds.has(listing.itemId)) continue;

        const deal = scoreDeal(listing, marketData, item.brand, item.avgSell);
        if (!deal) continue;

        // Only alert on Must Buy and Strong deals
        if (deal.confidenceTier === 'mustbuy' || deal.confidenceTier === 'strong') {
          alertDeals.push(deal);
          alertedIds.add(deal.id);
          console.log('[' + deal.confidenceTier.toUpperCase() + '] ' + deal.title + ' — Buy £' + deal.price + ' → Vinted £' + deal.vintedListPrice + ' (+£' + deal.vintedNet + ')');
        }
      }

      // Small delay between searches to be respectful
      await new Promise(r => setTimeout(r, 800));

    } catch (e) {
      console.error('Scan error for "' + item.q + '":', e.message);
    }
  }

  console.log('Scan complete — ' + alertDeals.length + ' deals found (' + alertDeals.filter(d => d.confidenceTier === 'mustbuy').length + ' Must Buy)');

  // Send email if we found anything worth alerting about
  if (alertDeals.length > 0) {
    // Sort: Must Buy first, then by profit
    alertDeals.sort((a, b) => {
      if (a.confidenceTier === 'mustbuy' && b.confidenceTier !== 'mustbuy') return -1;
      if (b.confidenceTier === 'mustbuy' && a.confidenceTier !== 'mustbuy') return 1;
      return b.vintedNet - a.vintedNet;
    });
    await sendEmailAlert(alertDeals.slice(0, 10)); // Max 10 per email
  }

  // Clear old alerted IDs after 24 hours to allow re-alerting
  if (alertedIds.size > 500) alertedIds.clear();
}

// ── SCHEDULE: Run scan every 2 hours ──
const SCAN_INTERVAL_MS = 2 * 60 * 60 * 1000;
async function scheduledScan() {
  await runScan();
  setTimeout(scheduledScan, SCAN_INTERVAL_MS);
}

// ── API ENDPOINTS ──
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    hasId: !!CLIENT_ID,
    hasSecret: !!CLIENT_SECRET,
    hasAI: !!ANTHROPIC_KEY,
    hasEmail: !!SENDGRID_KEY,
    alertEmail: ALERT_EMAIL || 'not set',
    alertedCount: alertedIds.size,
    nextScan: new Date(Date.now() + SCAN_INTERVAL_MS).toLocaleString('en-GB')
  });
});

// Manual scan trigger — visit /scan to force a scan immediately
app.get('/scan', async (req, res) => {
  res.json({ message: 'Scan started — check logs and your email' });
  runScan();
});

// Still serve the deals endpoint for the web app
app.get('/deals', async (req, res) => {
  try {
    const token = await getToken();
    const searchTerm = req.query.q || '';
    const q = encodeURIComponent(searchTerm);
    const min = req.query.minPrice || '0';
    const max = req.query.maxPrice || '15';
    const avgSell = parseFloat(req.query.avgSell || '45');
    const cat = req.query.cat || 'vintage';
    const brand = req.query.brand || '';

    const [ebayRes, marketData] = await Promise.all([
      fetch('https://api.ebay.com/buy/browse/v1/item_summary/search?q=' + q + '&limit=15&marketplace_ids=EBAY_GB&filter=price:[' + min + '..' + max + '],priceCurrency:GBP,itemLocationCountry:GB&sort=newlyListed', {
        headers: { 'Authorization': 'Bearer ' + token, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_GB' }
      }),
      getMarketPrices(req.query.vintedQ || searchTerm, token)
    ]);

    const ebayData = await ebayRes.json();
    const items = (ebayData.itemSummaries || []).filter(l => !shouldReject(l)).slice(0, 10);

    const deals = items.map(listing => {
      const deal = scoreDeal(listing, marketData, brand, avgSell);
      if (!deal) return null;
      return { ...deal, cat, marketData };
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

// Start server and kick off first scan
app.listen(process.env.PORT || 3000, async () => {
  console.log('FlipRadar bot running');
  console.log('Alert email: ' + (ALERT_EMAIL || 'NOT SET — add ALERT_EMAIL to Render environment'));
  console.log('Email service: ' + (SENDGRID_KEY ? 'SendGrid ready' : 'NOT SET — add SENDGRID_API_KEY to Render environment'));

  // Wait 30 seconds for server to fully start, then begin scanning
  setTimeout(scheduledScan, 30000);
});
