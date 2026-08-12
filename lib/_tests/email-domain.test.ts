import { describe, it, expect } from 'vitest';
import { checkEmailDomain, suggestEmailFix, emailDomainOf } from '../email-domain.js';

// A resolver stub standing in for dns.resolveMx. Keeps these tests off the
// network — a unit test that fails when the office wifi drops is worse than
// no test.
const resolverFor = (table: Record<string, unknown>) => async (domain: string) => {
  const entry = table[domain];
  if (entry === undefined) {
    const err = new Error('queryMx ENOTFOUND') as NodeJS.ErrnoException;
    err.code = 'ENOTFOUND';
    throw err;
  }
  if (entry === 'ENODATA') {
    const err = new Error('queryMx ENODATA') as NodeJS.ErrnoException;
    err.code = 'ENODATA';
    throw err;
  }
  return entry as { exchange: string; priority: number }[];
};

describe('emailDomainOf', () => {
  it('takes everything after the last @', () => {
    expect(emailDomainOf('someone@hotmail.com')).toBe('hotmail.com');
    expect(emailDomainOf('odd@name@example.org')).toBe('example.org');
  });

  it('lowercases and trims', () => {
    expect(emailDomainOf('  Person@Hotmail.COM ')).toBe('hotmail.com');
  });

  it('returns null when there is no domain to speak of', () => {
    expect(emailDomainOf('no-at-sign')).toBeNull();
    expect(emailDomainOf('trailing@')).toBeNull();
  });
});

describe('checkEmailDomain', () => {
  const resolve = resolverFor({
    'hotmail.com': [{ exchange: 'hotmail-com.olc.protection.outlook.com', priority: 2 }],
    // gmial.com is a real typosquat: it has an A record but publishes no MX.
    'gmial.com': 'ENODATA',
    // hotmail.co is the domain that swallowed four of Corinne's emails.
    // It does not exist at all.
  });

  it('accepts a domain that publishes MX records', async () => {
    expect(await checkEmailDomain('someone@hotmail.com', { resolve })).toBe('ok');
  });

  it('rejects a domain that does not exist', async () => {
    expect(await checkEmailDomain('corikara@hotmail.co', { resolve })).toBe('undeliverable');
  });

  it('rejects a domain with no MX records, even if it resolves', async () => {
    // Implicit-MX fallback to the A record is legal per RFC 5321, but in
    // practice an A-only "mail domain" is a typosquatter. Delivering there is
    // worse than bouncing.
    expect(await checkEmailDomain('someone@gmial.com', { resolve })).toBe('undeliverable');
  });

  it('treats an empty MX answer as undeliverable', async () => {
    const empty = resolverFor({ 'nomx.example': [] });
    expect(await checkEmailDomain('a@nomx.example', { resolve: empty })).toBe('undeliverable');
  });

  it('rejects an RFC 7505 null MX — the domain says it takes no mail', async () => {
    // This is what example.com publishes: `0 .`
    const nullMx = resolverFor({ 'example.com': [{ exchange: '.', priority: 0 }] });
    expect(await checkEmailDomain('sam@example.com', { resolve: nullMx })).toBe('undeliverable');
    const emptyExchange = resolverFor({ 'example.com': [{ exchange: '', priority: 0 }] });
    expect(await checkEmailDomain('sam@example.com', { resolve: emptyExchange })).toBe('undeliverable');
  });

  it('accepts a normal trailing-dot exchange', async () => {
    const dotted = resolverFor({ 'shaw.ca': [{ exchange: 'mx.shaw.ca.', priority: 10 }] });
    expect(await checkEmailDomain('a@shaw.ca', { resolve: dotted })).toBe('ok');
  });

  it('fails OPEN on a transient resolver error — never lose a sale to flaky DNS', async () => {
    const flaky = async () => {
      const err = new Error('queryMx ESERVFAIL') as NodeJS.ErrnoException;
      err.code = 'ESERVFAIL';
      throw err;
    };
    expect(await checkEmailDomain('someone@hotmail.com', { resolve: flaky })).toBe('unknown');
  });

  it('fails OPEN when the lookup is slower than the timeout', async () => {
    const slow = () => new Promise<never>(() => {});
    expect(await checkEmailDomain('a@slow.example', { resolve: slow, timeoutMs: 10 })).toBe('unknown');
  });

  it('fails OPEN on an unparseable address rather than blocking', async () => {
    expect(await checkEmailDomain('not-an-email', { resolve })).toBe('unknown');
  });

  it('never lets a placeholder walk-up address hit DNS', async () => {
    const explode = async () => {
      throw new Error('resolver must not be called');
    };
    expect(await checkEmailDomain('walkup+ab12cd34@luckyshamrock.ca', { resolve: explode })).toBe('ok');
  });

  it('skips the network entirely under the test-run marker', async () => {
    // The suite books hundreds of @example.com customers; without this the
    // whole thing would depend on live DNS. An injected resolver still runs.
    expect(process.env.LUCKYSHAMROCK_TEST_RUN).toBe('1');
    expect(await checkEmailDomain('sam@example.com')).toBe('unknown');
  });
});

describe('suggestEmailFix', () => {
  it('suggests the obvious correction for a known typo domain', () => {
    expect(suggestEmailFix('corikara@hotmail.co')).toBe('corikara@hotmail.com');
    expect(suggestEmailFix('bob@gmial.com')).toBe('bob@gmail.com');
    expect(suggestEmailFix('bob@gmail.con')).toBe('bob@gmail.com');
  });

  it('preserves the local part exactly, including dots and plus tags', () => {
    expect(suggestEmailFix('first.last+bins@yahoo.co')).toBe('first.last+bins@yahoo.com');
  });

  it('returns null when the domain looks fine', () => {
    expect(suggestEmailFix('someone@hotmail.com')).toBeNull();
    expect(suggestEmailFix('someone@telus.net')).toBeNull();
  });

  it('returns null for junk it cannot improve', () => {
    expect(suggestEmailFix('no-at-sign')).toBeNull();
  });
});
