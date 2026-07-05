import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { generateWashGif } from '../wash-gif.js';
import { LEPRECHAUN_SPRITES } from '../leprechaun-sprites.js';

async function fakePhoto(color: { r: number; g: number; b: number }): Promise<Buffer> {
  return sharp({ create: { width: 320, height: 340, channels: 3, background: color } })
    .jpeg()
    .toBuffer();
}

describe('generateWashGif', () => {
  it('produces an animated GIF from two photos and the embedded sprites', async () => {
    const gif = await generateWashGif({
      beforeJpeg: await fakePhoto({ r: 90, g: 80, b: 60 }),
      afterJpeg: await fakePhoto({ r: 40, g: 120, b: 70 }),
      sprites: LEPRECHAUN_SPRITES,
      stamps: { before: 'BEFORE · Jul 5, 2026, 2:14 p.m.', after: 'AFTER · Jul 5, 2026, 2:41 p.m.' },
    });
    // GIF89a magic + a plausible multi-frame size.
    expect(gif.subarray(0, 6).toString('ascii')).toBe('GIF89a');
    expect(gif.length).toBeGreaterThan(50_000);
    // Must stay email-friendly.
    expect(gif.length).toBeLessThan(3_000_000);
  }, 30_000);

  it('rejects an empty action sprite set', async () => {
    await expect(
      generateWashGif({
        beforeJpeg: await fakePhoto({ r: 0, g: 0, b: 0 }),
        afterJpeg: await fakePhoto({ r: 255, g: 255, b: 255 }),
        sprites: { action: [], smile: LEPRECHAUN_SPRITES.smile },
      }),
    ).rejects.toThrow(/action sprite/);
  });

  it('embedded sprites are valid PNGs with alpha', async () => {
    for (const buf of [...LEPRECHAUN_SPRITES.action, LEPRECHAUN_SPRITES.smile]) {
      const meta = await sharp(buf).metadata();
      expect(meta.format).toBe('png');
      expect(meta.hasAlpha).toBe(true);
    }
  });
});
