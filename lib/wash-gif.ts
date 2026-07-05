/**
 * Generates the animated "Lucky washes your bin" GIF for the done email:
 * the customer's BEFORE photo gets progressively covered in foam while the
 * leprechaun mascot — full body, pressure washer in hand — frantically cycles
 * through action poses at the foam front. The foam then wipes away to reveal
 * the AFTER photo and Lucky stands aside, smiling.
 *
 * Pure function of (beforeJpeg, afterJpeg, sprites) — no I/O, no env. Heavy
 * (sharp raster work + GIF quantization), so callers should treat it as
 * best-effort: on any failure the done email falls back to the static
 * before/after photos. Never let GIF generation break "Done".
 */

import sharp, { type OverlayOptions } from 'sharp';
// gifenc ships untyped dual CJS/ESM builds and the API lands on a different
// layer depending on who resolved it (Node CJS interop → `.default`, vitest's
// ESM build → the namespace itself). Pick whichever layer has GIFEncoder.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import * as gifencNs from 'gifenc';
const gifencApi = [gifencNs, (gifencNs as any).default, (gifencNs as any).default?.default].find(
  (o) => o && typeof (o as any).GIFEncoder === 'function',
);
if (!gifencApi) throw new Error('gifenc API not found on any module layer');
const { GIFEncoder, quantize, applyPalette } = gifencApi as {
  GIFEncoder: () => { writeFrame: (index: Uint8Array, w: number, h: number, opts: { palette: number[][]; delay: number }) => void; finish: () => void; bytes: () => Uint8Array };
  quantize: (rgba: Uint8ClampedArray, maxColors: number) => number[][];
  applyPalette: (rgba: Uint8ClampedArray, palette: number[][]) => Uint8Array;
};

export interface WashGifSprites {
  /** Frantic cleaning poses, cycled every frame while the foam sweeps. */
  action: Buffer[];
  /** "Ta-da" pose shown beside the revealed clean bin at the end. */
  smile: Buffer;
}

export interface WashGifInput {
  beforeJpeg: Buffer;
  afterJpeg: Buffer;
  sprites: WashGifSprites;
  /**
   * Subtle proof-of-service stamps rendered as a small corner pill inside the
   * frames: `before` on the dirty-bin segment, `after` on the reveal. Pass
   * preformatted strings (e.g. "BEFORE · Jul 5, 2026, 2:14 PM").
   */
  stamps?: { before: string; after: string } | null;
}

const W = 440; // output width; height follows the before photo's aspect
const MAX_H = 560;
const FRAME_MS = 150;
const HOLD_BEFORE = 2; // frames of untouched "before"
const FOAM_STEPS = 7; // frames of foam sweeping across
const HOLD_FOAM = 2; // fully foamed pause (still scrubbing)
const REVEAL_STEPS = 5; // foam sweeping away, revealing "after"
const HOLD_AFTER_MS = 2600; // long last-frame hold before the loop restarts
const SPRITE_HEIGHT_RATIO = 0.62; // big enough that arms/legs/washer read clearly

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

/**
 * Small semi-transparent pill in the bottom-left corner carrying the
 * BEFORE/AFTER timestamp — visible proof of service without shouting.
 */
function stampSvg(w: number, h: number, text: string): string {
  const fontSize = 13;
  const padX = 10;
  const pillH = 24;
  const pillW = Math.round(text.length * fontSize * 0.56) + padX * 2;
  const x = 10;
  const y = h - pillH - 10;
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<rect x="${x}" y="${y}" width="${pillW}" height="${pillH}" rx="12" fill="black" fill-opacity="0.45"/>` +
    `<text x="${x + padX}" y="${y + pillH - 8}" font-family="Helvetica, Arial, sans-serif" font-size="${fontSize}" ` +
    `font-weight="bold" fill="white" fill-opacity="0.95">${esc}</text>` +
    `</svg>`
  );
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
  if (!input.sprites.action.length) throw new Error('wash-gif: need at least one action sprite');

  // Normalize both photos to identical dimensions (before photo decides).
  const beforeMeta = await sharp(input.beforeJpeg).metadata();
  const aspect = (beforeMeta.height ?? 1) / (beforeMeta.width ?? 1);
  const H = Math.min(MAX_H, Math.max(240, Math.round(W * aspect)));

  const before = await sharp(input.beforeJpeg).resize(W, H, { fit: 'cover' }).toBuffer();
  const after = await sharp(input.afterJpeg).resize(W, H, { fit: 'cover' }).toBuffer();

  // Pre-scale sprites. All action poses share a height so the cycle doesn't jump.
  const spriteH = Math.round(H * SPRITE_HEIGHT_RATIO);
  const action: Array<{ png: Buffer; w: number }> = [];
  for (const a of input.sprites.action) {
    const png = await sharp(a).resize({ height: spriteH }).png().toBuffer();
    const m = await sharp(png).metadata();
    action.push({ png, w: m.width ?? 0 });
  }
  const smileH = Math.round(H * 0.5);
  const smilePng = await sharp(input.sprites.smile).resize({ height: smileH }).png().toBuffer();
  const smileW = (await sharp(smilePng).metadata()).width ?? 0;
  const maxActionW = Math.max(...action.map((a) => a.w));

  interface FrameSpec {
    base: Buffer;
    foamCoverage: number | null; // null = no foam layer
    sparkle: boolean;
    sprite: 'action' | 'smile' | null;
    spriteX: number | null;
    step: number;
    delayMs: number;
  }

  const specs: FrameSpec[] = [];
  let step = 0;
  for (let i = 0; i < HOLD_BEFORE; i++) {
    specs.push({ base: before, foamCoverage: null, sparkle: false, sprite: null, spriteX: null, step: step++, delayMs: FRAME_MS * 2 });
  }
  for (let i = 1; i <= FOAM_STEPS; i++) {
    const cov = i / FOAM_STEPS;
    // Lucky leads the foam front, gun pointed at the un-foamed side.
    const x = Math.round(cov * (W + maxActionW * 0.4) - maxActionW * 0.7);
    specs.push({ base: before, foamCoverage: cov, sparkle: false, sprite: 'action', spriteX: x, step: step++, delayMs: FRAME_MS });
  }
  for (let i = 0; i < HOLD_FOAM; i++) {
    specs.push({ base: before, foamCoverage: 1, sparkle: false, sprite: 'action', spriteX: W - maxActionW, step: step++, delayMs: FRAME_MS });
  }
  for (let i = 1; i <= REVEAL_STEPS; i++) {
    const cov = 1 - i / REVEAL_STEPS;
    specs.push({ base: after, foamCoverage: cov > 0 ? cov : null, sparkle: i >= REVEAL_STEPS - 1, sprite: null, spriteX: null, step: step++, delayMs: FRAME_MS });
  }
  // Finale: clean bin + Lucky standing proud, smiling (per the mascot video).
  specs.push({ base: after, foamCoverage: null, sparkle: true, sprite: 'smile', spriteX: W - smileW - 8, step: step++, delayMs: HOLD_AFTER_MS });

  const gif = GIFEncoder();
  for (const spec of specs) {
    const overlays: OverlayOptions[] = [];
    if (spec.foamCoverage !== null) {
      overlays.push({ input: Buffer.from(foamSvg(W, H, spec.foamCoverage, spec.step)) });
    }
    if (spec.sparkle) {
      overlays.push({ input: Buffer.from(sparkleSvg(W, H, spec.step)) });
    }
    if (spec.sprite === 'action' && spec.spriteX !== null) {
      // Cycle poses every frame — that's the frantic-cleaning effect.
      const pose = action[spec.step % action.length]!;
      const bob = spec.step % 2 === 0 ? 0 : Math.round(H * 0.015);
      overlays.push({
        input: pose.png,
        left: Math.max(-pose.w + 10, Math.min(W - 10, spec.spriteX)),
        top: H - spriteH + bob,
      });
    } else if (spec.sprite === 'smile' && spec.spriteX !== null) {
      overlays.push({ input: smilePng, left: spec.spriteX, top: H - smileH });
    }
    // Stamp goes on LAST so neither foam nor the sprite can cover it.
    if (input.stamps) {
      const label = spec.base === before ? input.stamps.before : input.stamps.after;
      overlays.push({ input: Buffer.from(stampSvg(W, H, label)) });
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
