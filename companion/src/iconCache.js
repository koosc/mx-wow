import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeBLP2, renderKeyIcon } from './blp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CACHE_DIR = path.resolve(__dirname, '..', '.cache', 'icons');

export class IconCache {
  constructor(cacheDir = DEFAULT_CACHE_DIR) {
    this.cacheDir = cacheDir;
    this.decoded = new Map(); // iconID -> { width, height, rgba }
    this.inFlight = new Map();
    this.failed = new Set();
  }

  async init() {
    await fs.mkdir(this.cacheDir, { recursive: true });
  }

  async getDecoded(iconID) {
    if (!iconID || iconID <= 0) return null;
    if (this.decoded.has(iconID)) return this.decoded.get(iconID);
    if (this.failed.has(iconID)) return null;
    if (this.inFlight.has(iconID)) return this.inFlight.get(iconID);

    const promise = this._loadOrFetch(iconID).finally(() => {
      this.inFlight.delete(iconID);
    });
    this.inFlight.set(iconID, promise);
    return promise;
  }

  async _loadOrFetch(iconID) {
    const filePath = path.join(this.cacheDir, `${iconID}.blp`);
    let buf = null;
    try {
      const diskBuf = await fs.readFile(filePath);
      if (diskBuf.length >= 148 && diskBuf.toString('ascii', 0, 4) === 'BLP2') {
        buf = diskBuf;
      }
    } catch {
      // Not cached yet
    }
    if (!buf) {
      // Fetch from wago.tools CASC API
      try {
        const res = await fetch(`https://wago.tools/api/casc/${iconID}`, {
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const ab = await res.arrayBuffer();
        const netBuf = Buffer.from(ab);
        if (netBuf.length < 148 || netBuf.toString('ascii', 0, 4) !== 'BLP2') {
          throw new Error('Response is not a valid BLP2 file');
        }
        buf = netBuf;
        await fs.writeFile(filePath, buf);
      } catch (err) {
        console.warn(`[IconCache] Failed to fetch icon ${iconID}: ${err.message}`);
        this.failed.add(iconID);
        return null;
      }
    }

    try {
      const img = decodeBLP2(buf);
      this.decoded.set(iconID, img);
      return img;
    } catch (err) {
      console.warn(`[IconCache] Failed to decode BLP2 for icon ${iconID}: ${err.message}`);
      this.failed.add(iconID);
      return null;
    }
  }

  async renderSlot(slot, width = 118, height = 118) {
    if (!slot.hasAction || !slot.iconID) {
      return null;
    }
    const img = await this.getDecoded(slot.iconID);
    if (!img) {
      return makeFallbackIcon(width, height);
    }
    return renderKeyIcon(img.rgba, img.width, img.height, width, height, {
      isUsable: slot.isUsable,
      notEnoughMana: slot.notEnoughMana,
      onCooldown: slot.onCooldown,
      isCurrent: slot.isCurrent,
      outOfRange: slot.outOfRange,
    });
  }
}

function makeFallbackIcon(width, height) {
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dst = (y * width + x) * 4;
      const border = x < 4 || x >= width - 4 || y < 4 || y >= height - 4;
      out[dst] = border ? 120 : 35;
      out[dst + 1] = border ? 120 : 40;
      out[dst + 2] = border ? 140 : 55;
      out[dst + 3] = 255;
    }
  }
  return out;
}
