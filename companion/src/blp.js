/**
 * Minimal pure-JS BLP2 decoder (WoW icon textures -> RGBA8888) and 118x118 resizer.
 * Supports BLP2 paletted (encoding 1), DXTC DXT1/DXT3/DXT5 (encoding 2), and BGRA8888 (encoding 3).
 */

function rgb565ToRgb888(c) {
  const r = ((c >> 11) & 0x1f) * 255 / 31;
  const g = ((c >> 5) & 0x3f) * 255 / 63;
  const b = (c & 0x1f) * 255 / 31;
  return [Math.round(r), Math.round(g), Math.round(b)];
}

function decodeDxt1Block(buf, offset, out, outStride, bx, by, width, height) {
  const c0 = buf.readUInt16LE(offset);
  const c1 = buf.readUInt16LE(offset + 2);
  const bits = buf.readUInt32LE(offset + 4);

  const [r0, g0, b0] = rgb565ToRgb888(c0);
  const [r1, g1, b1] = rgb565ToRgb888(c1);

  const colors = [
    [r0, g0, b0, 255],
    [r1, g1, b1, 255],
    c0 > c1
      ? [Math.round((2 * r0 + r1) / 3), Math.round((2 * g0 + g1) / 3), Math.round((2 * b0 + b1) / 3), 255]
      : [Math.round((r0 + r1) / 2), Math.round((g0 + g1) / 2), Math.round((b0 + b1) / 2), 255],
    c0 > c1
      ? [Math.round((r0 + 2 * r1) / 3), Math.round((g0 + 2 * g1) / 3), Math.round((b0 + 2 * b1) / 3), 255]
      : [0, 0, 0, 0],
  ];

  for (let py = 0; py < 4; py++) {
    const y = by + py;
    if (y >= height) continue;
    for (let px = 0; px < 4; px++) {
      const x = bx + px;
      if (x >= width) continue;
      const idx = (bits >>> (2 * (py * 4 + px))) & 0x3;
      const dst = (y * outStride + x) * 4;
      const col = colors[idx];
      out[dst] = col[0];
      out[dst + 1] = col[1];
      out[dst + 2] = col[2];
      out[dst + 3] = col[3];
    }
  }
}

function decodeDxt3Alpha(buf, offset, out, outStride, bx, by, width, height) {
  for (let py = 0; py < 4; py++) {
    const y = by + py;
    if (y >= height) continue;
    const row = buf.readUInt16LE(offset + py * 2);
    for (let px = 0; px < 4; px++) {
      const x = bx + px;
      if (x >= width) continue;
      const a4 = (row >>> (px * 4)) & 0xf;
      out[(y * outStride + x) * 4 + 3] = a4 * 17;
    }
  }
}

function decodeDxt5Alpha(buf, offset, out, outStride, bx, by, width, height) {
  const a0 = buf[offset];
  const a1 = buf[offset + 1];
  const alphas = [a0, a1];
  if (a0 > a1) {
    for (let i = 1; i <= 6; i++) {
      alphas.push(Math.round(((7 - i) * a0 + i * a1) / 7));
    }
  } else {
    for (let i = 1; i <= 4; i++) {
      alphas.push(Math.round(((5 - i) * a0 + i * a1) / 5));
    }
    alphas.push(0, 255);
  }

  // 48-bit little-endian bitfield across bytes 2..7
  let lo = buf.readUInt32LE(offset + 2);
  let hi = buf.readUInt16LE(offset + 6);
  const full = BigInt(lo) | (BigInt(hi) << 32n);

  for (let py = 0; py < 4; py++) {
    const y = by + py;
    if (y >= height) continue;
    for (let px = 0; px < 4; px++) {
      const x = bx + px;
      if (x >= width) continue;
      const bitIdx = BigInt(3 * (py * 4 + px));
      const idx = Number((full >> bitIdx) & 7n);
      out[(y * outStride + x) * 4 + 3] = alphas[idx];
    }
  }
}

export function decodeBLP2(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < 148 || buf.toString('ascii', 0, 4) !== 'BLP2') {
    throw new Error('Not a valid BLP2 file');
  }

  const compression = buf.readUInt8(8); // 1=paletted, 2=DXTC, 3=BGRA8888
  const alphaDepth = buf.readUInt8(9);
  const alphaEncoding = buf.readUInt8(10); // 0=DXT1, 1=DXT3, 7=DXT5
  const width = buf.readUInt32LE(12);
  const height = buf.readUInt32LE(16);
  const mipOffset = buf.readUInt32LE(20);
  const mipSize = buf.readUInt32LE(20 + 16 * 4);

  const rgba = new Uint8Array(width * height * 4);

  if (compression === 3) {
    // Raw BGRA8888
    for (let i = 0; i < width * height; i++) {
      const src = mipOffset + i * 4;
      const dst = i * 4;
      rgba[dst] = buf[src + 2];
      rgba[dst + 1] = buf[src + 1];
      rgba[dst + 2] = buf[src];
      rgba[dst + 3] = buf[src + 3];
    }
    return { width, height, rgba };
  }

  if (compression === 1) {
    // 256-entry BGRA palette at offset 148 (20 + 64 + 64)
    const paletteOffset = 148;
    const pixelCount = width * height;
    for (let i = 0; i < pixelCount; i++) {
      const pIdx = buf[mipOffset + i];
      const pal = paletteOffset + pIdx * 4;
      const dst = i * 4;
      rgba[dst] = buf[pal + 2];
      rgba[dst + 1] = buf[pal + 1];
      rgba[dst + 2] = buf[pal];
      rgba[dst + 3] = 255;
    }
    const alphaOffset = mipOffset + pixelCount;
    if (alphaDepth === 8 && alphaOffset + pixelCount <= buf.length) {
      for (let i = 0; i < pixelCount; i++) {
        rgba[i * 4 + 3] = buf[alphaOffset + i];
      }
    } else if (alphaDepth === 4 && alphaOffset + Math.ceil(pixelCount / 2) <= buf.length) {
      for (let i = 0; i < pixelCount; i++) {
        const b = buf[alphaOffset + (i >> 1)];
        const a4 = (i & 1) === 0 ? (b & 0xf) : ((b >> 4) & 0xf);
        rgba[i * 4 + 3] = a4 * 17;
      }
    } else if (alphaDepth === 1 && alphaOffset + Math.ceil(pixelCount / 8) <= buf.length) {
      for (let i = 0; i < pixelCount; i++) {
        const b = buf[alphaOffset + (i >> 3)];
        rgba[i * 4 + 3] = ((b >> (i & 7)) & 1) ? 255 : 0;
      }
    }
    return { width, height, rgba };
  }

  if (compression === 2) {
    const blocksX = Math.max(1, Math.ceil(width / 4));
    const blocksY = Math.max(1, Math.ceil(height / 4));
    const isDxt1 = alphaEncoding === 0 || (alphaDepth === 0 && alphaEncoding !== 1 && alphaEncoding !== 7);
    const blockBytes = isDxt1 ? 8 : 16;

    if (mipOffset + blocksX * blocksY * blockBytes > buf.length && mipSize < blocksX * blocksY * blockBytes) {
      throw new Error('Truncated DXTC mipmap data');
    }

    let pos = mipOffset;
    for (let by = 0; by < blocksY; by++) {
      for (let bx = 0; bx < blocksX; bx++) {
        if (isDxt1) {
          decodeDxt1Block(buf, pos, rgba, width, bx * 4, by * 4, width, height);
          if (alphaDepth === 0) {
            // Opaque DXT1
            for (let py = 0; py < 4; py++) {
              const y = by * 4 + py;
              if (y >= height) continue;
              for (let px = 0; px < 4; px++) {
                const x = bx * 4 + px;
                if (x >= width) continue;
                rgba[(y * width + x) * 4 + 3] = 255;
              }
            }
          }
        } else {
          // Color block is at +8
          decodeDxt1Block(buf, pos + 8, rgba, width, bx * 4, by * 4, width, height);
          if (alphaEncoding === 1) {
            decodeDxt3Alpha(buf, pos, rgba, width, bx * 4, by * 4, width, height);
          } else {
            decodeDxt5Alpha(buf, pos, rgba, width, bx * 4, by * 4, width, height);
          }
        }
        pos += blockBytes;
      }
    }
    return { width, height, rgba };
  }

  throw new Error(`Unsupported BLP2 compression: ${compression}`);
}

/**
 * Bilinear resize of RGBA8888 image + optional WoW slot state tint/border.
 */
export function renderKeyIcon(srcRgba, srcW, srcH, dstW = 118, dstH = 118, state = {}) {
  const out = new Uint8Array(dstW * dstH * 4);
  const {
    isUsable = true,
    notEnoughMana = false,
    onCooldown = false,
    isCurrent = false,
    outOfRange = false,
    gcdProgress = null,
  } = state;
  const hasGcdSweep = typeof gcdProgress === 'number' && gcdProgress >= 0 && gcdProgress < 1 && !onCooldown;
  const cx = (dstW - 1) / 2;
  const cy = (dstH - 1) / 2;
  const TWO_PI = Math.PI * 2;

  for (let y = 0; y < dstH; y++) {
    const sy = ((y + 0.5) * srcH) / dstH - 0.5;
    const y0 = Math.max(0, Math.min(srcH - 1, Math.floor(sy)));
    const y1 = Math.max(0, Math.min(srcH - 1, y0 + 1));
    const fy = Math.max(0, sy - y0);

    for (let x = 0; x < dstW; x++) {
      const sx = ((x + 0.5) * srcW) / dstW - 0.5;
      const x0 = Math.max(0, Math.min(srcW - 1, Math.floor(sx)));
      const x1 = Math.max(0, Math.min(srcW - 1, x0 + 1));
      const fx = Math.max(0, sx - x0);

      const i00 = (y0 * srcW + x0) * 4;
      const i10 = (y0 * srcW + x1) * 4;
      const i01 = (y1 * srcW + x0) * 4;
      const i11 = (y1 * srcW + x1) * 4;

      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;

      let r = srcRgba[i00] * w00 + srcRgba[i10] * w10 + srcRgba[i01] * w01 + srcRgba[i11] * w11;
      let g = srcRgba[i00 + 1] * w00 + srcRgba[i10 + 1] * w10 + srcRgba[i01 + 1] * w01 + srcRgba[i11 + 1] * w11;
      let b = srcRgba[i00 + 2] * w00 + srcRgba[i10 + 2] * w10 + srcRgba[i01 + 2] * w01 + srcRgba[i11 + 2] * w11;

      if (onCooldown) {
        r *= 0.35;
        g *= 0.35;
        b *= 0.35;
      } else if (notEnoughMana) {
        r *= 0.45;
        g *= 0.55;
        b = Math.min(255, b * 1.15);
      } else if (!isUsable) {
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        r = lum * 0.45;
        g = lum * 0.45;
        b = lum * 0.45;
      }

      // Radial clockwise GCD sweep from 12 o'clock
      if (hasGcdSweep) {
        const dx = x - cx;
        const dy = y - cy;
        let theta = Math.atan2(dx, -dy);
        if (theta < 0) theta += TWO_PI;
        const frac = theta / TWO_PI;
        if (frac >= gcdProgress) {
          r *= 0.25;
          g *= 0.25;
          b *= 0.25;
        }
        const distSq = dx * dx + dy * dy;
        if (distSq > 16 && Math.abs(frac - gcdProgress) < 0.022) {
          r = r * 0.3 + 255 * 0.7;
          g = g * 0.3 + 245 * 0.7;
          b = b * 0.3 + 200 * 0.7;
        }
      }

      // Subtle 3px border for active/out-of-range
      const isBorder = x < 3 || x >= dstW - 3 || y < 3 || y >= dstH - 3;
      if (isBorder) {
        if (isCurrent) {
          r = 255; g = 215; b = 0;
        } else if (outOfRange) {
          r = 220; g = 40; b = 40;
        }
      }

      const dst = (y * dstW + x) * 4;
      out[dst] = Math.round(r);
      out[dst + 1] = Math.round(g);
      out[dst + 2] = Math.round(b);
      out[dst + 3] = 255;
    }
  }
  return out;
}
