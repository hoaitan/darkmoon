import zlib from "node:zlib";

/**
 * Minimal PNG decoder (8-bit RGB/RGBA/grayscale, any standard per-scanline
 * filter) — just enough to read actual rendered pixel values out of a
 * Playwright screenshot buffer for capture.ts's pixel-level assertions.
 *
 * Why this exists at all: a `getComputedStyle().filter` check confirms a
 * filter was *declared*, not that it was *painted* — DAR-17 found a real
 * rendering gap (the CSS canvas-background-propagation paint layer, see
 * buildInjectedCss's comment in src/content/index.ts) where those two
 * completely disagreed: computed style read back exactly as declared while
 * the actual pixels still showed the page's original, un-inverted color.
 * No amount of computed-style or class-membership checking would have
 * caught that — only reading real pixels does.
 */
export interface DecodedPng {
  width: number;
  height: number;
  channels: number;
  pixels: Buffer;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function decodePng(buf: Buffer): DecodedPng {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks: Buffer[] = [];
  while (offset < buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data.readUInt8(8);
      colorType = data.readUInt8(9);
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth}`);
  const channelsByColorType: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const channels = channelsByColorType[colorType];
  if (channels === undefined) throw new Error(`unsupported PNG color type ${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  let rawOffset = 0;
  for (let y = 0; y < height; y++) {
    const filterType = raw[rawOffset];
    rawOffset += 1;
    const rowStart = y * stride;
    const prevRowStart = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[rawOffset + x] ?? 0;
      const a = x >= channels ? pixels[rowStart + x - channels] : 0;
      const b = y > 0 ? pixels[prevRowStart + x] : 0;
      const c = y > 0 && x >= channels ? pixels[prevRowStart + x - channels] : 0;
      let value: number;
      switch (filterType) {
        case 0:
          value = rawByte;
          break;
        case 1:
          value = (rawByte + (a ?? 0)) & 0xff;
          break;
        case 2:
          value = (rawByte + (b ?? 0)) & 0xff;
          break;
        case 3:
          value = (rawByte + Math.floor(((a ?? 0) + (b ?? 0)) / 2)) & 0xff;
          break;
        case 4:
          value = (rawByte + paeth(a ?? 0, b ?? 0, c ?? 0)) & 0xff;
          break;
        default:
          throw new Error(`unsupported PNG filter type ${filterType}`);
      }
      pixels[rowStart + x] = value;
    }
    rawOffset += stride;
  }
  return { width, height, channels, pixels };
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function getPixel(img: DecodedPng, x: number, y: number): Rgb {
  const idx = (y * img.width + x) * img.channels;
  return { r: img.pixels[idx] ?? 0, g: img.pixels[idx + 1] ?? 0, b: img.pixels[idx + 2] ?? 0 };
}

/** Perceptual-ish lightness in [0, 255], same weighting as the extension's own relativeLightness. */
export function pixelLightness({ r, g, b }: Rgb): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}
