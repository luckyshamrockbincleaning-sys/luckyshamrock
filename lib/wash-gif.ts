/**
 * Generates the animated "Lucky washes your bin" GIF for the done email:
 * the customer's BEFORE photo gets progressively covered in foam by the
 * leprechaun mascot, then the foam wipes away to reveal the AFTER photo.
 *
 * Pure function of (beforeJpeg, afterJpeg, sprite) — no I/O, no env. Heavy
 * (sharp raster work + GIF quantization), so callers should treat it as
 * best-effort: on any failure the done email falls back to the static
 * before/after card. Never let GIF generation break "Done".
 */

import sharp, { type OverlayOptions } from 'sharp';
// gifenc is CJS with no types; default-import for Node ESM interop.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import gifenc from 'gifenc';
const { GIFEncoder, quantize, applyPalette } = gifenc as {
  GIFEncoder: () => { writeFrame: (index: Uint8Array, w: number, h: number, opts: { palette: number[][]; delay: number }) => void; finish: () => void; bytes: () => Uint8Array };
  quantize: (rgba: Uint8ClampedArray, maxColors: number) => number[][];
  applyPalette: (rgba: Uint8ClampedArray, palette: number[][]) => Uint8Array;
};

export interface WashGifInput {
  beforeJpeg: Buffer;
  afterJpeg: Buffer;
  /** Transparent-background leprechaun PNG. Omit → foam-only animation. */
  spritePng?: Buffer | null;
}

const W = 440; // output width; height follows the before photo's aspect
const MAX_H = 560;
const FRAME_MS = 160;
const HOLD_BEFORE = 2; // frames of untouched "before"
const FOAM_STEPS = 6; // frames of foam sweeping across
const HOLD_FOAM = 2; // fully foamed pause
const REVEAL_STEPS = 5; // foam sweeping away, revealing "after"
const HOLD_AFTER_MS = 2600; // long last-frame hold before the loop restarts

/** Deterministic PRNG so the foam pattern is stable across runs/tests. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Foam layer as an SVG of overlapping soft white circles. `coverage` 0..1
 * sweeps left→right with a ragged bubbly edge; slight per-step jitter keeps
 * the suds alive between frames.
 */
function foamSvg(w: number, h: number, coverage: number, step: number): string {
  const rand = mulberry32(1979 + step * 7);
  const edge = coverage * (w + 90) - 45; // foam front x-position
  const parts: string[] = [];
  // Nearly-opaque foam body behind the front line — it must HIDE the photo,
  // not veil it, or it reads as overexposure instead of suds.
  if (edge > 0) {
    parts.push(`<rect x="0" y="0" width="${Math.min(edge, w).toFixed(1)}" height="${h}" fill="#f6fbff" fill-opacity="0.98"/>`);
    // Bubble texture inside the body: soft blue-grey shading circles that give
    // the flat white some sudsy depth.
    const texCount = Math.round((Math.min(edge, w) / w) * 60);
    for (let i = 0; i < texCount; i++) {
      const cx = rand() * Math.min(edge, w);
      const cy = rand() * h;
      const r = 12 + rand() * 30;
      parts.push(
        `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="none" ` +
          `stroke="#c9dcea" stroke-opacity="${(0.25 + rand() * 0.3).toFixed(2)}" stroke-width="${(2 + rand() * 3).toFixed(1)}"/>`,
      );
      if (rand() > 0.6) {
        // occasional highlight glint on a bubble
        parts.push(`<circle cx="${(cx - r * 0.3).toFixed(1)}" cy="${(cy - r * 0.3).toFixed(1)}" r="${(r * 0.15).toFixed(1)}" fill="white"/>`);
      }
    }
  }
  // Bubbly ragged front + floating suds.
  const bubbleCount = 52;
  for (let i = 0; i < bubbleCount; i++) {
    const along = rand(); // 0..1 down the height
    const cy = along * h;
    const cx = edge + (rand() - 0.35) * 70;
    if (cx < -30 || cx > w + 30) continue;
    const r = 8 + rand() * 26;
    const op = 0.75 + rand() * 0.25;
    parts.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="#f6fbff" fill-opacity="${op.toFixed(2)}"/>`);
  }
  // A few drifting sparkle bubbles ahead of the front.
  for (let i = 0; i < 10; i++) {
    const cx = edge + 30 + rand() * 120;
    const cy = rand() * h;
    if (cx > w + 20) continue;
    const r = 2 + rand() * 6;
    parts.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="white" fill-opacity="${(0.35 + rand() * 0.3).toFixed(2)}"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${parts.join('')}</svg>`;
}

/** Sparkles for the reveal frames. */
function sparkleSvg(w: number, h: number, step: number): string {
  const rand = mulberry32(333 + step * 11);
  const parts: string[] = [];
  for (let i = 0; i < 7; i++) {
    const cx = rand() * w;
    const cy = rand() * h;
    const s = 7 + rand() * 12;
    const op = (0.5 + rand() * 0.5).toFixed(2);
    parts.push(
      `<path d="M ${cx} ${cy - s} L ${cx + s * 0.28} ${cy - s * 0.28} L ${cx + s} ${cy} L ${cx + s * 0.28} ${cy + s * 0.28} ` +
        `L ${cx} ${cy + s} L ${cx - s * 0.28} ${cy + s * 0.28} L ${cx - s} ${cy} L ${cx - s * 0.28} ${cy - s * 0.28} Z" ` +
        `fill="#fff8d0" fill-opacity="${op}"/>`,
    );
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${parts.join('')}</svg>`;
}

export async function generateWashGif(input: WashGifInput): Promise<Buffer> {
  // Normalize both photos to identical dimensions (before photo decides).
  const beforeMeta = await sharp(input.beforeJpeg).metadata();
  const aspect = (beforeMeta.height ?? 1) / (beforeMeta.width ?? 1);
  const H = Math.min(MAX_H, Math.max(240, Math.round(W * aspect)));

  const before = await sharp(input.beforeJpeg).resize(W, H, { fit: 'cover' }).toBuffer();
  const after = await sharp(input.afterJpeg).resize(W, H, { fit: 'cover' }).toBuffer();

  // Sprite: ~55% of frame height, bobbing as he "scrubs".
  let sprite: Buffer | null = null;
  let spriteW = 0;
  let spriteH = 0;
  if (input.spritePng) {
    spriteH = Math.round(H * 0.55);
    const resized = await sharp(input.spritePng).resize({ height: spriteH }).png().toBuffer();
    const m = await sharp(resized).metadata();
    spriteW = m.width ?? 0;
    sprite = resized;
  }

  interface FrameSpec {
    base: Buffer;
    foamCoverage: number | null; // null = no foam layer
    reveal: boolean; // reveal frames sweep foam right→left over AFTER
    sparkle: boolean;
    spriteX: number | null; // null = sprite hidden
    step: number;
    delayMs: number;
  }

  const specs: FrameSpec[] = [];
  let step = 0;
  for (let i = 0; i < HOLD_BEFORE; i++) {
    specs.push({ base: before, foamCoverage: null, reveal: false, sparkle: false, spriteX: null, step: step++, delayMs: FRAME_MS * 2 });
  }
  for (let i = 1; i <= FOAM_STEPS; i++) {
    const cov = i / FOAM_STEPS;
    // Leprechaun rides the foam front, slightly behind it.
    const x = sprite ? Math.round(cov * (W + spriteW * 0.6) - spriteW * 0.8) : null;
    specs.push({ base: before, foamCoverage: cov, reveal: false, sparkle: false, spriteX: x, step: step++, delayMs: FRAME_MS });
  }
  for (let i = 0; i < HOLD_FOAM; i++) {
    specs.push({ base: before, foamCoverage: 1, reveal: false, sparkle: false, spriteX: sprite ? W - spriteW : null, step: step++, delayMs: FRAME_MS });
  }
  for (let i = 1; i <= REVEAL_STEPS; i++) {
    // Foam retreats right→left over the AFTER photo (coverage shrinks).
    const cov = 1 - i / REVEAL_STEPS;
    specs.push({ base: after, foamCoverage: cov > 0 ? cov : null, reveal: true, sparkle: i >= REVEAL_STEPS - 1, spriteX: null, step: step++, delayMs: FRAME_MS });
  }
  specs.push({ base: after, foamCoverage: null, reveal: true, sparkle: true, spriteX: null, step: step++, delayMs: HOLD_AFTER_MS });

  const gif = GIFEncoder();
  for (const spec of specs) {
    const overlays: OverlayOptions[] = [];
    if (spec.foamCoverage !== null) {
      overlays.push({ input: Buffer.from(foamSvg(W, H, spec.foamCoverage, spec.step)) });
    }
    if (spec.sparkle) {
      overlays.push({ input: Buffer.from(sparkleSvg(W, H, spec.step)) });
    }
    if (sprite && spec.spriteX !== null) {
      const bob = spec.step % 2 === 0 ? 0 : Math.round(H * 0.02); // scrubbing bob
      overlays.push({
        input: sprite,
        left: Math.max(-spriteW + 10, Math.min(W - 10, spec.spriteX)),
        top: H - spriteH + bob,
      });
    }
    const { data } = await sharp(spec.base)
      .composite(overlays)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const rgba = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
    const palette = quantize(rgba, 256);
    const indexed = applyPalette(rgba, palette);
    gif.writeFrame(indexed, W, H, { palette, delay: spec.delayMs });
  }
  gif.finish();
  return Buffer.from(gif.bytes());
}
