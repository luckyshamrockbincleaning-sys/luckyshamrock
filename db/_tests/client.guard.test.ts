import { describe, it, expect, afterEach } from 'vitest';
import { truncateAllForTests } from '../client.js';

describe('truncateAllForTests safety guards', () => {
  const origMarker = process.env.LUCKYSHAMROCK_TEST_RUN;
  const origDbUrl = process.env.DATABASE_URL;
  const origTestUrl = process.env.TEST_DATABASE_URL;

  afterEach(() => {
    process.env.LUCKYSHAMROCK_TEST_RUN = origMarker;
    process.env.DATABASE_URL = origDbUrl;
    process.env.TEST_DATABASE_URL = origTestUrl;
  });

  it('throws when LUCKYSHAMROCK_TEST_RUN marker is missing', async () => {
    delete process.env.LUCKYSHAMROCK_TEST_RUN;
    await expect(truncateAllForTests()).rejects.toThrow(/outside a vitest run/);
  });

  it('throws when DATABASE_URL has drifted from TEST_DATABASE_URL', async () => {
    process.env.LUCKYSHAMROCK_TEST_RUN = '1';
    process.env.DATABASE_URL = 'postgres://prod';
    process.env.TEST_DATABASE_URL = 'postgres://test';
    await expect(truncateAllForTests()).rejects.toThrow(/drifted from TEST_DATABASE_URL/);
  });
});
