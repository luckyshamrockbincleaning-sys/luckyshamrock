import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BIN_TYPES, BIN_TYPE_LABEL } from '../bin-types.js';

// The client bin list (pricing.js → window.LS_BIN_TYPES) must never drift from
// the server's lib/bin-types.ts. Same guard as pricing-sync: no build step
// means the browser can't import the server module, so the two lists are
// physically separate and only a test keeps them honest.
const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '..', 'pricing.js'), 'utf8');

function clientBinTypes(): { value: string; label: string }[] {
  const block = src.match(/window\.LS_BIN_TYPES\s*=\s*\[([\s\S]*?)\];/);
  if (!block) throw new Error('pricing.js is missing window.LS_BIN_TYPES');
  return [...block[1]!.matchAll(/\{\s*value:\s*'([^']+)'\s*,\s*label:\s*'([^']+)'/g)].map((m) => ({
    value: m[1]!,
    label: m[2]!,
  }));
}

describe('client bin types stay in sync with the server', () => {
  it('lists exactly the server types, in the same order', () => {
    // Order is load-bearing: bin 1 must mean the same bin every visit, because
    // photos and email sections are keyed by position.
    expect(clientBinTypes().map((b) => b.value)).toEqual([...BIN_TYPES]);
  });

  it('uses the same labels the server renders', () => {
    for (const b of clientBinTypes()) {
      expect(b.label).toBe(BIN_TYPE_LABEL[b.value as (typeof BIN_TYPES)[number]]);
    }
  });

  it('gives every bin a colour swatch', () => {
    const block = src.match(/window\.LS_BIN_TYPES\s*=\s*\[([\s\S]*?)\];/)![1]!;
    const swatches = [...block.matchAll(/swatch:\s*'(#[0-9a-fA-F]{3,8})'/g)];
    expect(swatches).toHaveLength(BIN_TYPES.length);
  });
});
