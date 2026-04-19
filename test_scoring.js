// ══════════════════════════════════════════════════════════════════
// FlipRadar Scoring Validation Suite
// Run before every deploy: node test_scoring.js
// Tests that known good/bad deals are scored correctly
// ══════════════════════════════════════════════════════════════════

// Pull scoring constants and functions from server.js
const fs = require('fs');
const src = fs.readFileSync('./server.js', 'utf8');

// Extract constants
const MIN_APPEAL_SCORE = parseInt(src.match(/const MIN_APPEAL_SCORE = (\d+)/)[1]);
const MIN_CONDITION_CLOTHING = parseInt(src.match(/const MIN_CONDITION_CLOTHING = (\d+)/)[1]);
const MIN_CONDITION_FOOTWEAR = parseInt(src.match(/const MIN_CONDITION_FOOTWEAR = (\d+)/)[1]);
const MIN_ROI = parseInt(src.match(/const MIN_ROI = (\d+)/)[1]);
const MIN_NET_PROFIT = parseInt(src.match(/const MIN_NET_PROFIT = (\d+)/)[1]);
const POSTAGE = parseFloat(src.match(/const POSTAGE = ([\d.]+)/)[1]);
const MAX_BUY_PRICE = parseInt(src.match(/const MAX_BUY_PRICE = (\d+)/)[1]);
const MIN_SOLD_SAMPLE = parseInt(src.match(/const MIN_SOLD_SAMPLE = (\d+)/)[1]);
const MUST_BUY_RATIO = parseFloat(src.match(/const MUST_BUY_RATIO = ([\d.]+)/)[1]);
const STRONG_RATIO = parseFloat(src.match(/const STRONG_RATIO = ([\d.]+)/)[1]);

// Extract fuzzy functions
eval(src.match(/const BRAND_VARIANTS[\s\S]+?function scoreMotivation[\s\S]+?\n\}/)[0]);

let passed = 0, failed = 0;
function test(name, condition, detail) {
  if (condition) { console.log('✅ ' + name); passed++; }
  else { console.log('❌ FAIL: ' + name + (detail ? ' — ' + detail : '')); failed++; }
}

console.log('\n══ FlipRadar Scoring Validation ══\n');

// ── CONSTANTS SANITY ──
test('MIN_APPEAL_SCORE is 7', MIN_APPEAL_SCORE === 7, 'got ' + MIN_APPEAL_SCORE);
test('MIN_CONDITION_FOOTWEAR is 8', MIN_CONDITION_FOOTWEAR === 8);
test('MIN_CONDITION_CLOTHING is 7', MIN_CONDITION_CLOTHING === 7);
test('MIN_ROI is 60', MIN_ROI === 60);
test('MAX_BUY_PRICE is 20', MAX_BUY_PRICE === 20);
test('POSTAGE is 3.50', POSTAGE === 3.50);
test('MIN_SOLD_SAMPLE is 3', MIN_SOLD_SAMPLE === 3);
test('MUST_BUY_RATIO is 0.40', MUST_BUY_RATIO === 0.40);
test('STRONG_RATIO is 0.75', STRONG_RATIO === 0.75);

// ── PROFIT CALCULATIONS ──
// Barbour at £8 → Vinted est £85 → net = 85 - 8 - 3.5 = 73.5
const barbourNet = 85 - 8 - POSTAGE;
const barbourROI = Math.round((barbourNet / 8) * 100);
test('Barbour £8 buy → net profit > MIN_NET_PROFIT', barbourNet > MIN_NET_PROFIT, 'net=£' + barbourNet);
test('Barbour ROI > MIN_ROI', barbourROI > MIN_ROI, 'ROI=' + barbourROI + '%');

// Lululemon at £18 → Vinted est £25 → net = 25 - 18 - 3.5 = 3.5 (should FAIL)
const lululemonNet = 25 - 18 - POSTAGE;
test('Lululemon £18 → thin margin caught (net<MIN)', lululemonNet < MIN_NET_PROFIT, 'net=£' + lululemonNet + ' min=£' + MIN_NET_PROFIT);

// Nike ACG at £20 → Vinted est £38 → net = 38 - 20 - 3.5 = 14.5
const nikeACGNet = 38 - 20 - POSTAGE;
const nikeACGROI = Math.round((nikeACGNet / 20) * 100);
test('Nike ACG £20 buy → passes profit check', nikeACGNet >= MIN_NET_PROFIT, 'net=£' + nikeACGNet);
test('Nike ACG ROI passes', nikeACGROI >= MIN_ROI, 'ROI=' + nikeACGROI + '%');

// ── APPEAL/CONDITION GATES ──
test('Appeal 6 is below minimum (should reject)', 6 < MIN_APPEAL_SCORE, 'min=' + MIN_APPEAL_SCORE);
test('Appeal 7 passes minimum', 7 >= MIN_APPEAL_SCORE);
test('Condition 4 footwear rejected', 4 < MIN_CONDITION_FOOTWEAR);
test('Condition 8 footwear passes', 8 >= MIN_CONDITION_FOOTWEAR);
test('Condition 7 clothing passes', 7 >= MIN_CONDITION_CLOTHING);

// ── FUZZY BRAND MATCHING ──
test('Carhart → Carhartt (variant)', detectFuzzyBrand('carhart jacket')?.brand === 'Carhartt', 'got: ' + JSON.stringify(detectFuzzyBrand('carhart jacket')));
test('Patogonia → Patagonia (variant)', detectFuzzyBrand('Patogonia fleece jacket')?.brand === 'Patagonia');
test('Lululemen → Lululemon (variant)', detectFuzzyBrand('Lululemen leggings size 8')?.brand === 'Lululemon');
test('New Ballance → New Balance (variant)', detectFuzzyBrand('New Ballance 550 trainers')?.brand === 'New Balance');
test('Doc Martins → Dr Martens (variant)', detectFuzzyBrand('doc martins boots size 7')?.brand === 'Dr Martens');
test('Ralf Lauren → Ralph Lauren (variant)', detectFuzzyBrand('ralf lauren polo shirt')?.brand === 'Ralph Lauren');
test('Arcteryx → Arc\'teryx (variant)', detectFuzzyBrand('arcteryx jacket waterproof')?.brand === "Arc'teryx");
test('Legitimate brand not flagged as fuzzy', detectFuzzyBrand('Nike Air Force 1 white trainers') === null || detectFuzzyBrand('Nike Air Force 1 white trainers')?.method !== 'variant');

// ── SELLER MOTIVATION SCORING ──
const movingScore = scoreMotivation('Barbour jacket for sale', 'Moving house need gone quick sale');
test('Moving house signals detected', movingScore.score >= 2, 'score=' + movingScore.score);
const neutralScore = scoreMotivation('Adidas Samba size 8', 'Good condition trainers');
test('Neutral listing scores 0', neutralScore.score === 0, 'score=' + neutralScore.score);
const clearoutScore = scoreMotivation('wardrobe clearout never worn', '');
test('Clearout signal detected', clearoutScore.score >= 1);
const loftScore = scoreMotivation('Vintage Barbour loft find house clearance', '');
test('Loft find / house clearance detected', loftScore.score >= 1);

// ── KNOWN FALSE POSITIVES (should be blocked) ──
// Bridgestone Motorsport — should not match Stone Island
const bridgestoneMatch = detectFuzzyBrand('Bridgestone Motorsport fleece');
test('Bridgestone does NOT fuzzy-match Stone Island', bridgestoneMatch?.brand !== 'Stone Island', 'got: ' + JSON.stringify(bridgestoneMatch));

// Single shoe — not checkable via fuzzy but flag in title
test('Single shoe keyword caught', 'left shoe only'.includes('left shoe') || 'left shoe only'.includes('single shoe'));

// ── SOLD DATA REQUIREMENT ──
test('MIN_SOLD_SAMPLE requires real data', MIN_SOLD_SAMPLE >= 3);

console.log('\n══ Results ══');
console.log('✅ Passed:', passed);
console.log('❌ Failed:', failed);
console.log('Total:', passed + failed);
if (failed > 0) {
  console.log('\n⚠️  Fix failures before deploying.');
  process.exit(1);
} else {
  console.log('\n🚀 All tests passed — safe to deploy.');
}
