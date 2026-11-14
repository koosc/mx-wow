import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decodePixelBridge } from '../src/pixelBridge.js';
import { decodeBLP2, renderKeyIcon } from '../src/blp.js';

function encodeMockStrip(slots, cellSize = 4, offsetX = 2, offsetY = 1, jitter = 0) {
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

  for (let i = 0; i < 12; i++) {
    const s = slots[i] || { iconID: 0, flags: 0, extra: 0 };
    const id = s.iconID >>> 0;
    const nib = (shift) => ((id >>> shift) & 0xf) * 17;
    const base = 3 + i * 3;
    paintCell(base, nib(24), nib(20), nib(16));
    paintCell(base + 1, nib(12), nib(8), nib(4));
    paintCell(base + 2, nib(0), (s.flags & 0xf) * 17, (s.extra & 0xf) * 17);
  }

  return { pixels, width, height };
}

describe('pixelBridge', () => {
  it('decodes 12 slots with 28-bit iconIDs and flags even under +-5 color drift', () => {
    const input = [
      { iconID: 135812, flags: 0b0011, extra: 0b01 }, // Fireball
      { iconID: 136048, flags: 0b1011, extra: 0b10 }, // Frostbolt on CD, out of range
      { iconID: 4622456, flags: 0b0101, extra: 0b00 }, // Large FileDataID, OOM
      { iconID: 0, flags: 0, extra: 0 },
    ];
    const { pixels, width, height } = encodeMockStrip(input, 4, 3, 2, 5);
    const decoded = decodePixelBridge(pixels, width, height, 3);

    assert.ok(decoded, 'Should find magic header');
    assert.equal(decoded.cellSize, 4);
    assert.equal(decoded.originX, 3);
    assert.equal(decoded.originY, 2);
    assert.equal(decoded.slots.length, 12);

    assert.equal(decoded.slots[0].iconID, 135812);
    assert.equal(decoded.slots[0].hasAction, true);
    assert.equal(decoded.slots[0].isUsable, true);
    assert.equal(decoded.slots[0].isCurrent, true);

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
  });
});
