// ══════════════════════════════════════════════════════════════
// FlipRadar Games Module — retro games and consoles
// Runs alongside clothing scanner, separate queue and scoring
// Resell platform: eBay (not Vinted — games sell better there)
// ══════════════════════════════════════════════════════════════

// ── Games search queue ────────────────────────────────────────
const GAMES_QUEUE = [
  // ── GBA / Game Boy ──
  { q: 'Pokemon Emerald GBA', soldQ: 'Pokemon Emerald GBA cartridge', brand: 'Pokemon', cat: 'gba', catId: '139971' },
  { q: 'Pokemon FireRed GBA', soldQ: 'Pokemon FireRed GBA cartridge', brand: 'Pokemon', cat: 'gba', catId: '139971' },
  { q: 'Pokemon LeafGreen GBA', soldQ: 'Pokemon LeafGreen GBA cartridge', brand: 'Pokemon', cat: 'gba', catId: '139971' },
  { q: 'Pokemon Crystal GBC', soldQ: 'Pokemon Crystal Game Boy Color', brand: 'Pokemon', cat: 'gbc', catId: '139971' },
  { q: 'Pokemon Gold GBC', soldQ: 'Pokemon Gold Game Boy Color', brand: 'Pokemon', cat: 'gbc', catId: '139971' },
  { q: 'Game Boy Advance console', soldQ: 'Game Boy Advance console GBA', brand: 'Nintendo', cat: 'console', catId: '139971' },
  { q: 'Game Boy Color console', soldQ: 'Game Boy Color console GBC', brand: 'Nintendo', cat: 'console', catId: '139971' },

  // ── N64 ──
  { q: 'Zelda Ocarina of Time N64', soldQ: 'Zelda Ocarina of Time N64 cartridge', brand: 'Nintendo', cat: 'n64', catId: '139971' },
  { q: 'Zelda Majoras Mask N64', soldQ: 'Zelda Majoras Mask N64 cartridge', brand: 'Nintendo', cat: 'n64', catId: '139971' },
  { q: 'Banjo Kazooie N64', soldQ: 'Banjo Kazooie N64 cartridge', brand: 'Nintendo', cat: 'n64', catId: '139971' },
  { q: 'Conker Bad Fur Day N64', soldQ: 'Conker Bad Fur Day N64', brand: 'Nintendo', cat: 'n64', catId: '139971' },
  { q: 'Nintendo 64 console', soldQ: 'Nintendo 64 console N64', brand: 'Nintendo', cat: 'console', catId: '139971' },

  // ── SNES ──
  { q: 'Super Nintendo SNES console', soldQ: 'Super Nintendo SNES console', brand: 'Nintendo', cat: 'console', catId: '139971' },
  { q: 'Zelda Link to the Past SNES', soldQ: 'Zelda Link to the Past SNES', brand: 'Nintendo', cat: 'snes', catId: '139971' },
  { q: 'Super Mario RPG SNES', soldQ: 'Super Mario RPG SNES cartridge', brand: 'Nintendo', cat: 'snes', catId: '139971' },

  // ── PS1 / PS2 ──
  { q: 'PlayStation 1 console PS1', soldQ: 'PlayStation 1 console PS1', brand: 'Sony', cat: 'console', catId: '139971' },
  { q: 'Crash Bandicoot PS1', soldQ: 'Crash Bandicoot PS1 PlayStation', brand: 'Sony', cat: 'ps1', catId: '139971' },
  { q: 'Spyro PS1', soldQ: 'Spyro the Dragon PS1 PlayStation', brand: 'Sony', cat: 'ps1', catId: '139971' },
  { q: 'Castlevania Symphony Night PS1', soldQ: 'Castlevania Symphony of the Night PS1', brand: 'Konami', cat: 'ps1', catId: '139971' },

  // ── Typo searches — zero competition ──
  { q: 'Zelda ocarina of time nintedo 64', soldQ: 'Zelda Ocarina of Time N64 cartridge', brand: 'Nintendo', cat: 'typo', catId: '139971' },
  { q: 'pokemon emrald gameboy', soldQ: 'Pokemon Emerald GBA cartridge', brand: 'Pokemon', cat: 'typo', catId: '139971' },
  { q: 'nintedo 64 console', soldQ: 'Nintendo 64 console N64', brand: 'Nintendo', cat: 'typo', catId: '139971' },
  { q: 'gamboy advance pokemon', soldQ: 'Pokemon GBA Game Boy Advance', brand: 'Pokemon', cat: 'typo', catId: '139971' },
];

// ── Games-specific postage ────────────────────────────────────
const GAMES_POSTAGE = 2.00; // cartridges are small/light
const CONSOLE_POSTAGE = 6.00; // consoles need tracked parcel

// ── Fake cart detection keywords ─────────────────────────────
const FAKE_SIGNALS = ['repro', 'reproduction', 'backup', 'copy', 'clone', 'translated', 'region free hack'];

// ── Claude scoring for games ─────────────────────────────────
async function scoreGame(deal, anthropicKey) {
  if (!anthropicKey) return null;
  try {
    const isConsole = deal.cat === 'console';
    const postage = isConsole ? CONSOLE_POSTAGE : GAMES_POSTAGE;
    const prompt = `You are a UK retro games expert reselling on eBay. Score this item strictly.

Item: "${deal.title}"
Buy price: £${deal.price}
Category: ${deal.cat}
Est. resell: £${deal.estSell}
Est. profit: £${(deal.estSell - deal.price - postage).toFixed(0)}

AUTHENTICITY (critical for cartridges):
- Check title for fake signals: repro, reproduction, backup, copy, clone, translated
- Pokemon/Zelda cartridges are heavily faked — vague titles are suspicious
- "Tested working" and seller photos of actual cart = more trustworthy
- SCORE AUTHENTICITY 1 if any fake signal present

APPEAL (1-10): Will this sell on eBay UK within 2 weeks?
- Complete In Box (CIB) / boxed with manual = +3 bonus
- Tested/working confirmed = +2
- Good/excellent condition = standard
- Untested = -3 (console hardware failure rate is high)
- Cracked case, yellowing, missing battery cover = -2
- Common titles (Mario Kart 64, Sonic) with no rarity = score 5 max

CONDITION (1-10):
- 9-10: Mint/near mint, complete, tested working
- 7-8: Good condition, tested working, minor cosmetic issues only
- 5-6: Working but significant cosmetic wear
- 1-4: Untested, damaged, incomplete, or suspicious

${deal.image ? 'Image provided — check for cart authenticity, label quality, condition.' : 'No image — be conservative.'}

INSTANTLY FAIL if: reproduction/fake cart, not working, console untested (too risky), bundle of 10+ games (can\\'t verify individually)

Respond ONLY with JSON:
{"appeal":7,"condition":8,"authentic":true,"appealReason":"max 10 words","conditionReason":"max 8 words","pass":true}`;

    const content = deal.image
      ? [{ type: 'image', source: { type: 'url', url: deal.image, media_type: 'image/jpeg' } }, { type: 'text', text: prompt }]
      : [{ type: 'text', text: prompt }];

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 120, messages: [{ role: 'user', content }] }),
      signal: AbortSignal.timeout(20000)
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = data.content?.[0]?.text?.trim();
    if (!text) return null;
    const scored = JSON.parse(text.replace(/```json|```/g, '').trim());
    if (!scored.authentic) return { pass: false, appeal: 1, condition: 1, appealReason: 'Potential fake/repro', conditionReason: 'Authenticity failed' };
    scored.pass = scored.appeal >= 7 && scored.condition >= 7 && scored.authentic !== false;
    return scored;
  } catch(e) { return null; }
}

module.exports = { GAMES_QUEUE, GAMES_POSTAGE, CONSOLE_POSTAGE, FAKE_SIGNALS, scoreGame };
