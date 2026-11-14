import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listMXCreativeConsoleDevices,
  openMxCreativeConsole,
} from '@logitech-mx-creative-console/node';
import { IconCache } from './iconCache.js';
import { BarCache } from './barCache.js';
import { decodePixelBridge } from './pixelBridge.js';
import { createCapturer } from './capture.js';
import { createKeyboard } from './keyboard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = { dryRun: false, captureMode: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--capture' && argv[i + 1]) args.captureMode = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage: node src/index.js [--capture auto|wayland|x11|windows] [--dry-run]');
      process.exit(0);
    }
  }
  return args;
}

async function loadConfig() {
  const userPath = path.join(ROOT_DIR, 'config.json');
  const examplePath = path.join(ROOT_DIR, 'config.example.json');
  try {
    return JSON.parse(await fs.readFile(userPath, 'utf8'));
  } catch {
    return JSON.parse(await fs.readFile(examplePath, 'utf8'));
  }
}

async function openKeypad() {
  const devices = await listMXCreativeConsoleDevices();
  const keypadInfo = devices.find((d) => d.model === 'mx-creative-keypad') || devices[0];
  if (!keypadInfo) {
    throw new Error(
      'No Logitech MX Creative Keypad detected. Check USB connection and udev permissions (/dev/hidraw*).'
    );
  }
  console.log(`[Keypad] Found ${keypadInfo.model} at ${keypadInfo.path}`);
  return openMxCreativeConsole(keypadInfo.path, { resetToLogoOnClose: true });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadConfig();
  if (args.captureMode) config.captureMode = args.captureMode;

  const iconCache = new IconCache();
  await iconCache.init();

  const barCache = new BarCache();
  await barCache.init();

  // Pre-warm BLP2 decode cache for any previously cached bars
  for (const slots of barCache.bars.values()) {
    for (const s of slots) {
      if (s.hasAction && s.iconID) iconCache.getDecoded(s.iconID).catch(() => {});
    }
  }

  const keyboard = createKeyboard({ dryRun: args.dryRun });
  await keyboard.init();

  const keypad = await openKeypad();
  await keypad.setBrightness(config.brightness ?? 80);
  await keypad.clearPanel();

  const capturer = createCapturer({
    mode: config.captureMode || 'auto',
    ...config.captureRegion,
  });
  await capturer.init();
  console.log(`[Capture] Initialized (${config.captureMode || 'auto'})`);

  let latestSlots = [];
  const renderedState = new Array(9).fill('');

  async function refreshKeypad(force = false) {
    const tasks = [];
    for (let keyIdx = 0; keyIdx < 9; keyIdx++) {
      const slot = latestSlots[keyIdx];
      const sig = slot
        ? `${slot.hasAction ? 1 : 0}:${slot.iconID}:${slot.flags}:${slot.extra}`
        : 'empty';

      if (!force && renderedState[keyIdx] === sig) continue;
      renderedState[keyIdx] = sig;

      if (!slot || !slot.hasAction || !slot.iconID) {
        tasks.push(keypad.clearKey(keyIdx).catch(() => {}));
        continue;
      }

      tasks.push(
        iconCache.renderSlot(slot, 118, 118).then((rgba) => {
          if (rgba) {
            return keypad.fillKeyBuffer(keyIdx, rgba, { format: 'rgba' }).catch((err) => {
              console.warn(`[Keypad] fillKeyBuffer(${keyIdx}) error: ${err.message}`);
            });
          }
        })
      );
    }
    if (tasks.length > 0) {
      await Promise.all(tasks);
    }
  }

  keypad.on('down', (control) => {
    if (control.index === 9 || control.index === 10) {
      const delta = control.index === 9 ? -1 : 1;
      const key =
        delta === -1
          ? config.barCycleKeys?.prev || 'CTRL+SHIFT+F11'
          : config.barCycleKeys?.next || 'CTRL+SHIFT+F12';
      const { targetBar, cachedSlots } = barCache.predictCycle(delta);
      console.log(`[Keypad] ${delta === -1 ? 'Prev' : 'Next'} Bar -> Bar ${targetBar} (${key})`);
      keyboard.sendKey(key);
      if (cachedSlots) {
        latestSlots = cachedSlots;
        refreshKeypad(false).catch(() => {});
      }
      return;
    }
    if (control.index >= 0 && control.index < 9) {
      const slotIdx = control.index;
      const combo = config.keybindings?.[slotIdx];
      if (combo) {
        console.log(`[Keypad] Slot ${slotIdx + 1} -> ${combo}`);
        keyboard.sendKey(combo);
      }
    }
  });

  keypad.on('error', (err) => {
    console.error('[Keypad] Error:', err);
  });

  // Periodic brightness keep-alive to prevent firmware auto-dimming
  const brightnessTimer = setInterval(() => {
    keypad.setBrightness(config.brightness ?? 80).catch(() => {});
  }, 25000);

  let running = true;
  const shutdown = async () => {
    if (!running) return;
    running = false;
    clearInterval(brightnessTimer);
    await barCache.flush().catch(() => {});
    await capturer.close();
    await keyboard.close();
    await keypad.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  let bridgeFound = false;
  while (running) {
    try {
      const frame = await capturer.capture();
      const decoded = decodePixelBridge(frame.pixels, frame.width, frame.height, frame.channels);
      if (decoded) {
        if (!bridgeFound) {
          bridgeFound = true;
          console.log(
            `[Bridge] Locked onto MXKeypadSync at (${decoded.originX}, ${decoded.originY}), cellSize=${decoded.cellSize}px, bar=${decoded.bar ?? '?'}`
          );
        }
        const { ignored, slots } = barCache.onBridgeFrame(decoded);
        if (!ignored && slots) {
          latestSlots = slots;
          await refreshKeypad(false);
        }
      } else if (bridgeFound) {
        bridgeFound = false;
        console.log('[Bridge] Waiting for WoW MXKeypadSync pixel strip...');
      }
    } catch (err) {
      console.warn(`[Loop] ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, config.pollIntervalMs ?? 100));
  }
}

main().catch((err) => {
  console.error('[Fatal]', err);
  process.exit(1);
});
