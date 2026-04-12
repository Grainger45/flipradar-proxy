// FlipRadar Pro - server.js
// The definitive version. Real sold data. Auction sniping. Telegram alerts. No Vinted API.
// ENV VARS: EBAY_APP_ID, ANTHROPIC_API_KEY, RESEND_API_KEY, ALERT_EMAIL, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID

const express = require('express');
const https = require('https');
const http = require('http');
const app = express();
app.use(express.json());

// ── Config ────────────────────────────────────────────────────
const MAX_BUY = parseFloat(process.env.MAX_BUY_PRICE || '20');
const MIN_PROFIT = parseFloat(process.env.MIN_PROFIT || '8');
const POSTAGE = 3.50;
const ALERT_EMAIL = process.env.ALERT_EMAIL || 'l.grainger1996@gmail.com';
const SCAN_INTERVAL_MS = 2 * 60 * 1000; // scan every 2 minutes

// ── State ─────────────────────────────────────────────────────
let alertedIds = new Set();
let alertedCount = 0;
let scanCount = 0;
let lastScanTime = null;
let lastDealsAlerted = [];
let recentDeals = []; // last 50 deals for dashboard
let soldDataCache = {}; // cache real sold prices per search term

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
async function getRealSoldData(query) {
  const cacheKey = query.toLowerCase();
  const now = Date.now();

  // Cache for 4 hours
  if (soldDataCache[cacheKey] && (now - soldDataCache[cacheKey].timestamp) < 4 * 60 * 60 * 1000) {
    return soldDataCache[cacheKey].data;
  }

  try {
    const encodedQuery = encodeURIComponent(query);
    const url = `https://www.ebay.co.uk/sch/i.html?_nkw=${encodedQuery}&LH_Complete=1&LH_Sold=1&LH_ItemCondition=3000&_ipg=60&_sop=13`;
    const html = await fetchUrl(url);

    // Extract sold prices from HTML
    const priceMatches = html.match(/class="s-item__price"[^>]*>[\s\S]*?£([\d,]+\.?\d*)/g) || [];
    const prices = [];

    for (const match of priceMatches) {
      const num = parseFloat(match.replace(/[^0-9.]/g, ''));
      if (num >= 3 && num <= 500) prices.push(num);
    }

    if (prices.length < 3) {
      soldDataCache[cacheKey] = { timestamp: now, data: null };
      return null;
    }

    prices.sort((a, b) => a - b);
    // Remove outliers (top and bottom 10%)
    const trimStart = Math.floor(prices.length * 0.1);
    const trimEnd = Math.ceil(prices.length * 0.9);
    const trimmed = prices.slice(trimStart, trimEnd);
    const median = trimmed[Math.floor(trimmed.length / 2)];
    const low = trimmed[0];
    const high = trimmed[trimmed.length - 1];

    const data = {
      median: Math.round(median * 100) / 100,
      low: Math.round(low * 100) / 100,
      high: Math.round(high * 100) / 100,
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
];

// ── eBay search (Buy It Now) ───────────────────────────────────
async function searchEbayBIN(item, soldData) {
  try {
    if (!soldData || soldData.median < 5) return [];

    const maxBuy = Math.min(Math.floor(soldData.median * 0.45), MAX_BUY);
    if (maxBuy < 2) return [];

    const params = new URLSearchParams({
      'OPERATION-NAME': 'findItemsAdvanced',
      'SERVICE-VERSION': '1.13.0',
      'SECURITY-APPNAME': process.env.EBAY_APP_ID,
      'RESPONSE-DATA-FORMAT': 'JSON',
      'keywords': item.q,
      'paginationInput.entriesPerPage': '30',
      'itemFilter(0).name': 'MaxPrice',
      'itemFilter(0).value': maxBuy,
      'itemFilter(0).paramName': 'Currency',
      'itemFilter(0).paramValue': 'GBP',
      'itemFilter(1).name': 'MinPrice',
      'itemFilter(1).value': '1',
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

    return processItems(items, item, soldData, 'BIN');
  } catch(e) {
    console.error(`BIN search error (${item.q}):`, e.message);
    return [];
  }
}

// ── eBay auction sniping (ending soon, low bids) ──────────────
async function searchEbayAuctions(item, soldData) {
  try {
    if (!soldData || soldData.median < 5) return [];

    const maxBuy = Math.min(Math.floor(soldData.median * 0.35), MAX_BUY);
    if (maxBuy < 2) return [];

    const params = new URLSearchParams({
      'OPERATION-NAME': 'findItemsAdvanced',
      'SERVICE-VERSION': '1.13.0',
      'SECURITY-APPNAME': process.env.EBAY_APP_ID,
      'RESPONSE-DATA-FORMAT': 'JSON',
      'keywords': item.q,
      'paginationInput.entriesPerPage': '20',
      'itemFilter(0).name': 'MaxPrice',
      'itemFilter(0).value': maxBuy,
      'itemFilter(0).paramName': 'Currency',
      'itemFilter(0).paramValue': 'GBP',
      'itemFilter(1).name': 'MinPrice',
      'itemFilter(1).value': '0.99',
      'itemFilter(2).name': 'ListingType',
      'itemFilter(2).value': 'Auction',
      'itemFilter(3).name': 'Condition',
      'itemFilter(3).value': 'Used',
      'itemFilter(4).name': 'LocatedIn',
      'itemFilter(4).value': 'GB',
      'itemFilter(5).name': 'EndTimeTo',
      'itemFilter(5).value': new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(), // ending in 3 hours
      'sortOrder': 'EndTimeSoonest',
    });

    const data = await fetchUrl(`https://svcs.ebay.com/services/search/FindingService/v1?${params}`);
    const parsed = JSON.parse(data);
    const items = parsed?.findItemsAdvancedResponse?.[0]?.searchResult?.[0]?.item || [];

    return processItems(items, item, soldData, 'Auction');
  } catch(e) {
    console.error(`Auction search error (${item.q}):`, e.message);
    return [];
  }
}

function processItems(items, queueItem, soldData, listingType) {
  const deals = [];
  for (const ebayItem of items) {
    try {
      const price = parseFloat(ebayItem.sellingStatus?.[0]?.currentPrice?.[0]?.['__value__'] || '0');
      if (price < 1 || price > MAX_BUY) continue;

      const title = ebayItem.title?.[0] || '';
      const itemId = ebayItem.itemId?.[0] || '';
      const url = ebayItem.viewItemURL?.[0] || '';
      const image = ebayItem.galleryURL?.[0] || '';
      const endDate = ebayItem.listingInfo?.[0]?.endTime?.[0] || null;
      const bidCount = parseInt(ebayItem.sellingStatus?.[0]?.bidCount?.[0] || '0');
      const freeShipping = ebayItem.shippingInfo?.[0]?.shippingType?.[0] === 'Free';

      // Calculate real profit using actual sold data
      const vintedTarget = Math.round(soldData.median * 0.85); // list slightly below median
      const ebayTarget = Math.round(soldData.median * 0.9);
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
      if (marketPercent <= 30) score += 50; // buying at 30% or less of market
      else if (marketPercent <= 45) score += 35;
      else if (marketPercent <= 55) score += 20;
      if (roi >= 200) score += 30;
      else if (roi >= 150) score += 20;
      else if (roi >= 100) score += 10;
      if (soldData.sampleSize >= 20) score += 10; // strong market evidence
      if (freeShipping) score += 5;
      if (listingType === 'Auction' && bidCount === 0) score += 15; // no bids = opportunity

      if (score >= 70) tier = 'mustbuy';
      else if (score >= 45) tier = 'strong';

      // Calculate auction urgency
      let hoursLeft = null;
      if (endDate) {
        hoursLeft = Math.round((new Date(endDate) - Date.now()) / 3600000 * 10) / 10;
      }

      deals.push({
        id: itemId, title, price, url, image,
        brand: queueItem.brand, cat: queueItem.cat,
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
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) return false;
  try {
    const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
    const body = JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' });
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    return res.ok;
  } catch(e) { return false; }
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
💡 Buying at ${d.marketPercent}% of market value${urgency}
${d.analysis ? `\n🤖 ${d.analysis}` : ''}

<a href="${d.url}">👉 View on eBay</a>`;

    await sendTelegram(msg);
    await sleep(500);
  }

  // Email digest
  const cards = deals.map(d => `
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
          ${d.analysis ? `<p style="font-size:13px;color:#374151;font-style:italic;margin:0 0 12px;">🤖 ${d.analysis}</p>` : ''}
          <div style="display:flex;gap:8px;">
            <a href="${d.url}" style="background:#111;color:#fff;padding:8px 16px;border-radius:8px;font-size:13px;font-weight:600;text-decoration:none;">View on eBay →</a>
            <a href="https://www.vinted.co.uk/catalog?search_text=${encodeURIComponent(d.title)}&order=newest_first" style="background:#EAF3DE;color:#3B6D11;padding:8px 16px;border-radius:8px;font-size:13px;font-weight:600;text-decoration:none;">Check Vinted →</a>
          </div>
        </div>
      </div>
    </div>`).join('');

  await sendEmail(
    `🔥 FlipRadar: ${deals.length} must-buy deal${deals.length>1?'s':''} — ${new Date().toLocaleString('en-GB')}`,
    `<div style="max-width:640px;margin:0 auto;padding:20px;font-family:sans-serif;">
      <h1 style="font-size:22px;font-weight:700;color:#111;margin:0 0 4px;">🔥 ${deals.length} deal${deals.length>1?'s':''} found</h1>
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

  // Process 4 items per scan (rotate through queue)
  const batch = [];
  for (let i = 0; i < 4; i++) {
    batch.push(QUEUE[(qIdx + i) % QUEUE.length]);
  }
  qIdx = (qIdx + 4) % QUEUE.length;

  const newDeals = [];

  for (const item of batch) {
    try {
      // Get real sold data
      const soldData = await getRealSoldData(item.soldQ);
      if (!soldData) { await sleep(300); continue; }

      // Search BIN listings
      const binDeals = await searchEbayBIN(item, soldData);
      for (const deal of binDeals) {
        if (!alertedIds.has(deal.id)) newDeals.push(deal);
      }

      // Search ending auctions
      const auctionDeals = await searchEbayAuctions(item, soldData);
      for (const deal of auctionDeals) {
        if (!alertedIds.has(deal.id)) newDeals.push(deal);
      }

      await sleep(400);
    } catch(e) {
      console.error(`Scan error for ${item.q}:`, e.message);
    }
  }

  scanCount++;
  lastScanTime = new Date();

  // Deduplicate
  const uniqueDeals = [];
  const seenInBatch = new Set();
  for (const deal of newDeals) {
    if (!seenInBatch.has(deal.id)) {
      seenInBatch.add(deal.id);
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

    alertDeals.forEach(d => alertedIds.add(d.id));
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
  telegramEnabled: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
  emailReady: !!process.env.RESEND_API_KEY,
  maxBuyPrice: MAX_BUY, minProfit: MIN_PROFIT,
  queueSize: QUEUE.length, alertedSoFar: alertedCount,
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
      <p><strong>Telegram:</strong> ${process.env.TELEGRAM_BOT_TOKEN ? '✅ Configured' : '⚠ Not configured (optional but recommended)'}</p>
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
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
    return res.send('⚠️ Telegram not configured. Add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to Render env vars for instant phone alerts.');
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

// ── Start ──────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FlipRadar Pro running on port ${PORT}`);
  console.log(`Config: max buy £${MAX_BUY}, min profit £${MIN_PROFIT}, scan every 2 mins`);
  console.log(`Email: ${process.env.RESEND_API_KEY ? 'Resend ✅' : '❌ Not configured'}`);
  console.log(`Telegram: ${process.env.TELEGRAM_BOT_TOKEN ? '✅' : 'Not configured'}`);
  console.log('Vinted API scanning: DISABLED');
  scheduleScan();
});
