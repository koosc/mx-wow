import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Captures a rectangular region of the screen as raw RGB24 bytes.
 */
export function createCapturer({ mode = 'auto', x = 0, y = 0, width = 320, height = 64 } = {}) {
  const resolved = mode === 'auto' ? detectMode() : mode;

  if (resolved === 'windows') {
    return new WindowsCapturer(x, y, width, height);
  }
  if (resolved === 'wayland') {
    return new WaylandCapturer(x, y, width, height);
  }
  if (resolved === 'x11') {
    return new X11Capturer(x, y, width, height);
  }
  throw new Error(`Unknown capture mode: ${resolved}`);
}

function detectMode() {
  if (process.platform === 'win32') return 'windows';
  if (process.env.XDG_SESSION_TYPE === 'wayland') return 'wayland';
  return 'x11';
}

class X11Capturer {
  constructor(x, y, width, height) {
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
    this.display = process.env.DISPLAY || ':0';
  }

  async init() {}

  async capture() {
    const { stdout } = await execFileAsync(
      'ffmpeg',
      [
        '-loglevel', 'error',
        '-f', 'x11grab',
        '-video_size', `${this.width}x${this.height}`,
        '-i', `${this.display}+${this.x},${this.y}`,
        '-vframes', '1',
        '-f', 'rawvideo',
        '-pix_fmt', 'rgb24',
        'pipe:1',
      ],
      { encoding: 'buffer', maxBuffer: this.width * this.height * 3 + 4096 }
    );
    return { pixels: stdout, width: this.width, height: this.height, channels: 3 };
  }

  async close() {}
}

class WindowsCapturer {
  constructor(x, y, width, height) {
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
    this.proc = null;
    this.pending = null;
    this.buf = Buffer.alloc(0);
    this.frameBytes = width * height * 3;
  }

  async init() {
    const script = `
Add-Type -AssemblyName System.Drawing
$w = ${this.width}; $h = ${this.height}; $x = ${this.x}; $y = ${this.y}
$bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$out = [Console]::OpenStandardOutput()
$rowBytes = $w * 3
$frame = New-Object byte[] ($rowBytes * $h)
while ($null -ne ($line = [Console]::ReadLine())) {
  $g.CopyFromScreen($x, $y, 0, 0, $bmp.Size)
  $rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
  $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  for ($row = 0; $row -lt $h; $row++) {
    $ptr = [IntPtr]::Add($data.Scan0, $row * $data.Stride)
    [System.Runtime.InteropServices.Marshal]::Copy($ptr, $frame, $row * $rowBytes, $rowBytes)
  }
  $bmp.UnlockBits($data)
  # Convert BGR -> RGB in-place
  for ($i = 0; $i -lt $frame.Length; $i += 3) {
    $tmp = $frame[$i]; $frame[$i] = $frame[$i + 2]; $frame[$i + 2] = $tmp
  }
  $out.Write($frame, 0, $frame.Length)
  $out.Flush()
}
`;
    this.proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    this.proc.stdout.on('data', (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      if (this.pending && this.buf.length >= this.frameBytes) {
        const frame = this.buf.subarray(0, this.frameBytes);
        this.buf = this.buf.subarray(this.frameBytes);
        const resolve = this.pending;
        this.pending = null;
        resolve({ pixels: frame, width: this.width, height: this.height, channels: 3 });
      }
    });
  }

  capture() {
    return new Promise((resolve, reject) => {
      if (!this.proc) return reject(new Error('WindowsCapturer not initialized'));
      this.pending = resolve;
      this.proc.stdin.write('1\n');
    });
  }

  async close() {
    this.proc?.kill();
    this.proc = null;
  }
}

class WaylandCapturer {
  constructor(x, y, width, height) {
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
    this.proc = null;
    this.latestFrame = null;
    this.frameBytes = width * height * 3;
    this.buf = Buffer.alloc(0);
  }

  async init() {
    const helper = path.join(__dirname, 'wayland_capture.py');
    this.proc = spawn('python3', [helper, String(this.x), String(this.y), String(this.width), String(this.height)], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for Wayland ScreenCast portal')), 30000);
      this.proc.on('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error(`wayland_capture.py exited with code ${code}`));
      });
      this.proc.stdout.on('data', (chunk) => {
        this.buf = Buffer.concat([this.buf, chunk]);
        while (this.buf.length >= this.frameBytes) {
          this.latestFrame = this.buf.subarray(0, this.frameBytes);
          this.buf = this.buf.subarray(this.frameBytes);
          clearTimeout(timeout);
          resolve();
        }
      });
    });
  }

  async capture() {
    if (!this.latestFrame) {
      throw new Error('No Wayland frame received yet');
    }
    return { pixels: this.latestFrame, width: this.width, height: this.height, channels: 3 };
  }

  async close() {
    this.proc?.kill();
    this.proc = null;
  }
}
