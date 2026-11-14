/**
 * Decodes the MXKeypadSync pixel bridge from a captured RGB/RGBA image buffer.
 */

const NUM_SLOTS = 12;
const TOL = 25;

function isMagenta(r, g, b) {
  return r >= 255 - TOL && g <= TOL && b >= 255 - TOL;
}

function isCyan(r, g, b) {
  return r <= TOL && g >= 255 - TOL && b >= 255 - TOL;
}

function isYellow(r, g, b) {
  return r >= 255 - TOL && g >= 255 - TOL && b <= TOL;
}

function toNibble(v) {
  return Math.min(15, Math.max(0, Math.round(v / 17)));
}

/**
 * Find the magic header (Magenta -> Cyan -> Yellow) in a buffer and decode the 12 slots.
 * @param {Uint8Array|Buffer} pixels - Raw image bytes
 * @param {number} width - Image width in pixels
 * @param {number} height - Image height in pixels
 * @param {number} channels - 3 (RGB) or 4 (RGBA)
 * @returns {{ cellSize: number, originX: number, originY: number, slots: Array } | null}
 */
export function decodePixelBridge(pixels, width, height, channels = 4) {
  const getRGB = (x, y) => {
    const idx = (y * width + x) * channels;
    return [pixels[idx], pixels[idx + 1], pixels[idx + 2]];
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width - 78; x++) {
      const [r, g, b] = getRGB(x, y);
      if (!isMagenta(r, g, b)) continue;

      // Measure run length of Magenta to infer approximate cellSize
      let approxCell = 0;
      while (approxCell < 20 && x + approxCell < width) {
        const [mr, mg, mb] = getRGB(x + approxCell, y);
        if (!isMagenta(mr, mg, mb)) break;
        approxCell++;
      }
      if (approxCell < 2 || approxCell > 16) continue;
      if (x + 39 * approxCell > width) continue;

      const midY = Math.min(height - 1, y + Math.floor(approxCell / 2));
      const c1x = x + Math.round(1.5 * approxCell);
      const c2x = x + Math.round(2.5 * approxCell);

      const [r1, g1, b1] = getRGB(c1x, midY);
      const [r2, g2, b2] = getRGB(c2x, midY);
      if (!isCyan(r1, g1, b1) || !isYellow(r2, g2, b2)) continue;

      // Measure total width of the 3 magic cells for sub-pixel-accurate cellWidth
      let magicEnd = c2x;
      while (magicEnd < width && magicEnd - x < 64) {
        const [yr, yg, yb] = getRGB(magicEnd, midY);
        if (!isYellow(yr, yg, yb)) break;
        magicEnd++;
      }
      const cellWidth = (magicEnd - x) / 3;
      if (x + Math.ceil(39 * cellWidth) > width) continue;

      const sampleCell = (cellIdx) => {
        const sx = Math.min(width - 1, Math.round(x + (cellIdx + 0.5) * cellWidth));
        return getRGB(sx, midY);
      };

      // Check optional Cell 3 metadata: (bar, maxBar, marker: 0xA=40 cells, 0xB=41 cells with GCD)
      const [mR, mG, mB] = sampleCell(3);
      const marker = toNibble(mB);
      const hasMeta = (marker === 0xA || marker === 0xB) && toNibble(mR) >= 1 && toNibble(mR) <= 8;
      const hasGcdCell = hasMeta && marker === 0xB;
      const bar = hasMeta ? toNibble(mR) : null;
      const maxBar = hasMeta ? Math.max(bar, toNibble(mG) || 5) : null;
      const slotOffset = hasGcdCell ? 5 : hasMeta ? 4 : 3;
      if (x + Math.ceil((slotOffset + 36) * cellWidth) > width) continue;

      let gcd = null;
      if (hasGcdCell) {
        const [gR, gG, gB] = sampleCell(4);
        const seq = toNibble(gR);
        const progress = toNibble(gG) / 15;
        const durationMs = toNibble(gB) * 100;
        gcd = seq > 0 && durationMs > 0 ? { seq, progress, durationMs } : { seq: 0, progress: 0, durationMs: 0 };
      }

      // Valid magic header found! Decode 12 slots.
      const slots = [];
      for (let i = 0; i < NUM_SLOTS; i++) {
        const baseCell = slotOffset + i * 3;
        const [aR, aG, aB] = sampleCell(baseCell);
        const [bR, bG, bB] = sampleCell(baseCell + 1);
        const [cR, cG, cB] = sampleCell(baseCell + 2);

        const n6 = toNibble(aR);
        const n5 = toNibble(aG);
        const n4 = toNibble(aB);
        const n3 = toNibble(bR);
        const n2 = toNibble(bG);
        const n1 = toNibble(bB);
        const n0 = toNibble(cR);
        const flags = toNibble(cG);
        const extra = toNibble(cB);

        const iconID =
          (n6 << 24) |
          (n5 << 20) |
          (n4 << 16) |
          (n3 << 12) |
          (n2 << 8) |
          (n1 << 4) |
          n0;

        slots.push({
          slot: i + 1,
          iconID: iconID >>> 0,
          hasAction: (flags & 1) !== 0,
          isUsable: (flags & 2) !== 0,
          notEnoughMana: (flags & 4) !== 0,
          onCooldown: (flags & 8) !== 0,
          isCurrent: (extra & 1) !== 0,
          outOfRange: (extra & 2) !== 0,
          onGCD: (extra & 4) !== 0,
          flags,
          extra,
        });
      }

      return { cellSize: Number(cellWidth.toFixed(2)), originX: x, originY: y, bar, maxBar, gcd, slots };
    }
  }

  return null;
}
