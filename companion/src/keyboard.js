import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createKeyboard({ dryRun = false } = {}) {
  if (dryRun) {
    return {
      async init() {},
      sendKey(combo) {
        console.log(`[Keyboard:dryRun] Would send: ${combo}`);
      },
      async close() {},
    };
  }
  if (process.platform === 'win32') {
    return new WindowsKeyboard();
  }
  return new LinuxUInputKeyboard();
}

class LinuxUInputKeyboard {
  constructor() {
    this.proc = null;
    this.available = true;
  }

  async init() {
    const helper = path.join(__dirname, 'uinput_keys.py');
    this.proc = spawn('python3', [helper], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    this.proc.stderr.on('data', (d) => {
      const msg = d.toString().trim();
      if (msg) console.warn(`[Keyboard:uinput] ${msg}`);
    });
    this.proc.on('exit', (code) => {
      if (code !== 0 && this.available) {
        this.available = false;
        console.warn('[Keyboard:uinput] /dev/uinput unavailable (check udev rules); keystrokes disabled.');
      }
    });
  }

  sendKey(combo) {
    if (!this.available || !this.proc?.stdin.writable) return;
    this.proc.stdin.write(`${combo}\n`);
  }

  async close() {
    this.proc?.kill();
    this.proc = null;
  }
}

class WindowsKeyboard {
  constructor() {
    this.proc = null;
  }

  async init() {
    const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinKey {
  [DllImport("user32.dll")]
  public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@
$vkMap = @{
  "CTRL"=0x11; "SHIFT"=0x10; "ALT"=0x12;
  "1"=0x31; "2"=0x32; "3"=0x33; "4"=0x34; "5"=0x35; "6"=0x36; "7"=0x37; "8"=0x38; "9"=0x39; "0"=0x30;
  "-"=0xBD; "MINUS"=0xBD; "="=0xBB; "EQUAL"=0xBB;
  "F1"=0x70; "F2"=0x71; "F3"=0x72; "F4"=0x73; "F5"=0x74; "F6"=0x75;
  "F7"=0x76; "F8"=0x77; "F9"=0x78; "F10"=0x79; "F11"=0x7A; "F12"=0x7B;
  "F13"=0x7C; "F14"=0x7D; "F15"=0x7E; "F16"=0x7F; "F17"=0x80; "F18"=0x81;
  "F19"=0x82; "F20"=0x83; "F21"=0x84; "F22"=0x85; "F23"=0x86; "F24"=0x87;
  "LEFT"=0x25; "UP"=0x26; "RIGHT"=0x27; "DOWN"=0x28; "["=0xDB; "]"=0xDD
}
while ($null -ne ($line = [Console]::ReadLine())) {
  $parts = $line.Trim().ToUpper().Split('+') | Where-Object { $_ -ne "" }
  $codes = @()
  foreach ($p in $parts) { if ($vkMap.ContainsKey($p)) { $codes += [byte]$vkMap[$p] } }
  if ($codes.Count -eq 0) { continue }
  foreach ($c in $codes) { [WinKey]::keybd_event($c, 0, 0, [UIntPtr]::Zero) }
  Start-Sleep -Milliseconds 20
  [array]::Reverse($codes)
  foreach ($c in $codes) { [WinKey]::keybd_event($c, 0, 2, [UIntPtr]::Zero) }
}
`;
    this.proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: ['pipe', 'ignore', 'inherit'],
    });
  }

  sendKey(combo) {
    if (!this.proc?.stdin.writable) return;
    this.proc.stdin.write(`${combo}\n`);
  }

  async close() {
    this.proc?.kill();
    this.proc = null;
  }
}
