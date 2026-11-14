import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CACHE_PATH = path.resolve(__dirname, '..', '.cache', 'bars.json');

function serializeBarSig(slots) {
  return slots.map((s) => `${s.hasAction ? 1 : 0}:${s.iconID}:${s.flags}:${s.extra}`).join(',');
}

function toPreviewSlots(slots) {
  return slots.map((s) => ({
    slot: s.slot,
    iconID: s.iconID,
    hasAction: s.hasAction,
    isUsable: s.isUsable,
    notEnoughMana: s.notEnoughMana,
    onCooldown: s.onCooldown,
    isCurrent: false,
    outOfRange: s.outOfRange,
    flags: s.flags,
    extra: s.extra & ~1,
  }));
}

export class BarCache {
  constructor(cachePath = DEFAULT_CACHE_PATH) {
    this.cachePath = cachePath;
    this.currentBar = 3;
    this.maxBar = 5;
    this.bars = new Map(); // barNum -> preview slots[]
    this.barSigs = new Map(); // barNum -> string
    this.pendingSwitch = null; // { fromBar, targetBar, until }
    this.saveTimer = null;
  }

  async init() {
    await fs.mkdir(path.dirname(this.cachePath), { recursive: true });
    try {
      const raw = JSON.parse(await fs.readFile(this.cachePath, 'utf8'));
      if (typeof raw.maxBar === 'number' && raw.maxBar >= 1 && raw.maxBar <= 8) {
        this.maxBar = raw.maxBar;
      }
      if (raw.bars && typeof raw.bars === 'object') {
        for (const [k, slots] of Object.entries(raw.bars)) {
          const barNum = Number(k);
          if (barNum >= 1 && barNum <= 8 && Array.isArray(slots)) {
            this.bars.set(barNum, slots);
            this.barSigs.set(barNum, serializeBarSig(slots));
          }
        }
      }
    } catch {
      // No cache yet
    }
  }

  _scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush().catch(() => {});
    }, 500);
  }

  async flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const obj = {
      maxBar: this.maxBar,
      bars: Object.fromEntries(this.bars.entries()),
    };
    await fs.mkdir(path.dirname(this.cachePath), { recursive: true });
    await fs.writeFile(this.cachePath, JSON.stringify(obj));
  }

  /**
   * Optimistically predict the next bar when Prev/Next is pressed.
   * Returns cached preview slots if available so the keypad updates immediately.
   */
  predictCycle(delta, now = Date.now()) {
    const baseBar = this.pendingSwitch ? this.pendingSwitch.targetBar : this.currentBar;
    const max = this.maxBar || 5;
    const targetBar = ((((baseBar - 1 + delta) % max) + max) % max) + 1;
    this.pendingSwitch = {
      fromBar: this.currentBar,
      targetBar,
      until: now + 600,
    };
    return {
      targetBar,
      cachedSlots: this.bars.get(targetBar) || null,
    };
  }

  /**
   * Process a live decoded frame from the pixel bridge.
   * Ignores stale frames from the previous bar during an active optimistic switch.
   */
  onBridgeFrame(decoded, now = Date.now()) {
    if (decoded.maxBar) {
      this.maxBar = decoded.maxBar;
    }

    if (this.pendingSwitch) {
      if (decoded.bar && decoded.bar === this.pendingSwitch.fromBar && now < this.pendingSwitch.until) {
        return { ignored: true, bar: this.pendingSwitch.targetBar, slots: null };
      }
      this.pendingSwitch = null;
    }

    if (decoded.bar) {
      this.currentBar = decoded.bar;
      const sig = serializeBarSig(decoded.slots);
      if (this.barSigs.get(decoded.bar) !== sig) {
        this.barSigs.set(decoded.bar, sig);
        this.bars.set(decoded.bar, toPreviewSlots(decoded.slots));
        this._scheduleSave();
      }
    }

    return { ignored: false, bar: this.currentBar, slots: decoded.slots };
  }
}
