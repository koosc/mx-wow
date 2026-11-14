import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { decodePixelBridge } from '../src/pixelBridge.js';
import { BarCache } from '../src/barCache.js';
import { decodeBLP2, renderKeyIcon } from '../src/blp.js';

function encodeMockStrip(
  slots,
  cellSize = 4,
  offsetX = 2,
  offsetY = 1,
  jitter = 0,
  meta = { bar: 3, maxBar: 5, gcd: { seq: 4, progressNib: 5, durNib: 15 } }
) {
  const width = 320;
  const height = 24;
  const pixels = new Uint8Array(width * height * 3);

  const paintCell = (cellIdx, r, g, b) => {
    const startX = offsetX + cellIdx * cellSize;
    for (let dy = 0; dy < cellSize; dy++) {
      for (let dx = 0; dx < cellSize; dx++) {
        const idx = ((offsetY + dy) * width + (startX + dx)) * 3;
        pixels[idx] = Math.min(255, Math.max(0, r + jitter));
        pixels[idx + 1] = Math.min(255, Math.max(0, g - jitter));
        pixels[idx + 2] = Math.min(255, Math.max(0, b + jitter));
      }
    }
  };

  paintCell(0, 255, 0, 255);
  paintCell(1, 0, 255, 255);
  paintCell(2, 255, 255, 0);
  if (meta) {
    const hasGcd = Boolean(meta.gcd);
    paintCell(3, meta.bar * 17, meta.maxBar * 17, (hasGcd ? 0xB : 0xA) * 17);
    if (hasGcd) {
      paintCell(4, meta.gcd.seq * 17, meta.gcd.progressNib * 17, meta.gcd.durNib * 17);
    }
  }

  const slotStart = meta ? (meta.gcd ? 5 : 4) : 3;
  for (let i = 0; i < 12; i++) {
    const s = slots[i] || { iconID: 0, flags: 0, extra: 0 };
    const id = s.iconID >>> 0;
    const nib = (shift) => ((id >>> shift) & 0xf) * 17;
    const base = slotStart + i * 3;
    paintCell(base, nib(24), nib(20), nib(16));
    paintCell(base + 1, nib(12), nib(8), nib(4));
    paintCell(base + 2, nib(0), (s.flags & 0xf) * 17, (s.extra & 0xf) * 17);
  }

  return { pixels, width, height };
}

describe('pixelBridge', () => {
  it('decodes 12 slots with 28-bit iconIDs and flags even under +-5 color drift', () => {
    const input = [
      { iconID: 135812, flags: 0b0011, extra: 0b101 }, // Fireball active + onGCD
      { iconID: 136048, flags: 0b1011, extra: 0b010 }, // Frostbolt on CD, out of range
      { iconID: 4622456, flags: 0b0101, extra: 0b000 }, // Large FileDataID, OOM
      { iconID: 0, flags: 0, extra: 0 },
    ];
    const { pixels, width, height } = encodeMockStrip(input, 4, 3, 2, 5);
    const decoded = decodePixelBridge(pixels, width, height, 3);

    assert.ok(decoded, 'Should find magic header');
    assert.equal(decoded.cellSize, 4);
    assert.equal(decoded.originX, 3);
    assert.equal(decoded.originY, 2);
    assert.equal(decoded.bar, 3);
    assert.equal(decoded.maxBar, 5);
    assert.equal(decoded.gcd.seq, 4);
    assert.equal(decoded.gcd.durationMs, 1500);
    assert.equal(decoded.slots.length, 12);

    assert.equal(decoded.slots[0].iconID, 135812);
    assert.equal(decoded.slots[0].hasAction, true);
    assert.equal(decoded.slots[0].isUsable, true);
    assert.equal(decoded.slots[0].isCurrent, true);
    assert.equal(decoded.slots[0].onGCD, true);

    assert.equal(decoded.slots[1].iconID, 136048);
    assert.equal(decoded.slots[1].onCooldown, true);
    assert.equal(decoded.slots[1].outOfRange, true);

    assert.equal(decoded.slots[2].iconID, 4622456);
    assert.equal(decoded.slots[2].notEnoughMana, true);

    assert.equal(decoded.slots[3].hasAction, false);
    assert.equal(decoded.slots[3].iconID, 0);
  });
});

describe('blp2 decoder', () => {
  it('fetches and decodes real WoW Fireball icon (135812) and resizes to 118x118', async () => {
    const res = await fetch('https://wago.tools/api/casc/135812');
    assert.equal(res.ok, true);
    const buf = Buffer.from(await res.arrayBuffer());
    const img = decodeBLP2(buf);
    assert.equal(img.width, 64);
    assert.equal(img.height, 64);
    assert.equal(img.rgba.length, 64 * 64 * 4);

    // Check that pixels aren't all zero
    let nonZero = 0;
    for (let i = 0; i < img.rgba.length; i += 4) {
      if (img.rgba[i] > 0 || img.rgba[i + 1] > 0 || img.rgba[i + 2] > 0) nonZero++;
    }
    assert.ok(nonZero > 1000, 'Decoded Fireball icon should have visible pixels');

    const resized = renderKeyIcon(img.rgba, img.width, img.height, 118, 118, { isUsable: true });
    assert.equal(resized.length, 118 * 118 * 4);

    // At gcdProgress=0.25, top-right quadrant (x=90,y=25) is swept (bright), bottom-left (x=25,y=90) is darkened
    const whiteSrc = new Uint8Array(64 * 64 * 4).fill(200);
    const swept = renderKeyIcon(whiteSrc, 64, 64, 118, 118, { isUsable: true, gcdProgress: 0.25 });
    const topRightIdx = (25 * 118 + 90) * 4;
    const bottomLeftIdx = (90 * 118 + 25) * 4;
    assert.equal(swept[topRightIdx], 200);
    assert.equal(swept[bottomLeftIdx], 50);
  });
});

describe('BarCache', () => {
  it('optimistically switches to cached bar, ignores stale frames, and reconciles live frames', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mxwow-barcache-'));
    const cacheFile = path.join(tmpDir, 'bars.json');
    try {
      const cache = new BarCache(cacheFile);
      await cache.init();

      const bar3Slots = [{ slot: 1, iconID: 135812, hasAction: true, isUsable: true, notEnoughMana: false, onCooldown: false, outOfRange: false, flags: 3, extra: 0 }];
      const bar4Slots = [{ slot: 1, iconID: 136048, hasAction: true, isUsable: false, notEnoughMana: false, onCooldown: false, outOfRange: false, flags: 1, extra: 0 }];

      cache.onBridgeFrame({ bar: 3, maxBar: 5, slots: bar3Slots }, 1000);
      cache.onBridgeFrame({ bar: 4, maxBar: 5, slots: bar4Slots }, 1100);
      cache.onBridgeFrame({ bar: 3, maxBar: 5, slots: bar3Slots }, 1200);

      // Press Next Bar (3 -> 4): returns bar 4 cached slots immediately (preserving disabled/greyed-out state)
      const pred = cache.predictCycle(1, 1300);
      assert.equal(pred.targetBar, 4);
      assert.equal(pred.cachedSlots[0].iconID, 136048);
      assert.equal(pred.cachedSlots[0].isUsable, false);

      // Stale frame from bar 3 arriving 100ms later is ignored
      const stale = cache.onBridgeFrame({ bar: 3, maxBar: 5, slots: bar3Slots }, 1400);
      assert.equal(stale.ignored, true);

      // Live frame from bar 4 reconciles and clears pending switch
      const liveBar4 = [{ slot: 1, iconID: 136048, hasAction: true, isUsable: true, onCooldown: true, flags: 11, extra: 0 }];
      const live = cache.onBridgeFrame({ bar: 4, maxBar: 5, slots: liveBar4 }, 1450);
      assert.equal(live.ignored, false);
      assert.equal(live.bar, 4);
      assert.equal(live.slots[0].onCooldown, true);

      await cache.flush();

      // Reload from disk and verify persistence
      const reloaded = new BarCache(cacheFile);
      await reloaded.init();
      assert.equal(reloaded.bars.get(4)[0].iconID, 136048);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
