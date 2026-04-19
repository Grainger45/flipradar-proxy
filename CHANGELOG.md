# FlipRadar Changelog

## 2026-04-19 — Foundation Rebuild

### Scoring thresholds consolidated
All deal-quality constants moved to one block at top of server.js:
- MIN_APPEAL_SCORE = 7 (was 6 — raised to reduce niche/slow-sell items passing)
- MIN_CONDITION_CLOTHING = 7
- MIN_CONDITION_FOOTWEAR = 8
- MIN_ROI = 60%
- MIN_NET_PROFIT = £10
- MIN_SOLD_SAMPLE = 3 (new — items with 0 real sold data now rejected)

### Test suite added
`test_scoring.js` — run with `node test_scoring.js` before every deploy.
Validates all constants, profit calculations, appeal gates, fuzzy matching, motivation scoring.
Currently: 34 tests, 34 passing.

### Fuzzy brand matching (new)
`detectFuzzyBrand(title)` — Levenshtein + variant dictionary for 20+ brands.
Catches misspellings invisible to all other bots: Carhart, Patogonia, Lululemen, etc.
Confidence score boosted +8 for fuzzy matches.

### Seller motivation scoring (new)
`scoreMotivation(title, description)` — detects motivated sellers.
30 signals: "moving house", "need gone", "quick sale", "loft find", etc.
Confidence score boosted +3 per signal found.

### Auto-suspend underperforming searches (new)
`searchPerformance` map tracks last qualifying deal per search.
`runWeeklySuspendCheck()` runs every 7 days — suspends searches with 0 deals in 14 days.
Telegram notification sent when searches suspended. Auto-reactivates on next deal found.

### Extended typo queue
Added 11 more explicit misspelling searches (Carhart, Arcteryx, Lululemen, etc.)

### Previous issues fixed this sprint
- Vinted 403: improved browser headers
- eBay rate limiting: 30-min scan cycle, 6-hr cache
- Oxfam brand matching: word-boundary regex (fixed Bridgestone/Stone Island)
- Depop: disabled (403 from Render free tier IPs)
- MIN_ROI lowered 100→60 to stop near-MAX_BUY_PRICE items failing

---

## Known limitations (to fix with paid Render tier)
- Vinted: blocked at IP level on Render free tier
- Depop: same IP block issue
- Restart wipes in-memory tokens and search performance data
  → Fix: VINTED_REFRESH_TOKEN stored in Render env vars survives restart
