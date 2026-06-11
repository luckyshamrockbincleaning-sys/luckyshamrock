import type { VercelRequest, VercelResponse } from '@vercel/node';
import { waitUntil } from '@vercel/functions';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../../db/client.js';
import { customer, magicLinkToken } from '../../db/schema.js';
import { generateMagicLinkToken, hashToken } from '../../lib/tokens.js';
import { sendAndLog } from '../../lib/notifications.js';
import { magicLinkTemplate } from '../../lib/email/templates.js';

const TOKEN_TTL_MS = 60 * 60 * 1000;

const requestSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
});

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ status: 'invalid', errors: parsed.error.flatten().fieldErrors });
    return;
  }

  const siteUrl = process.env.SITE_URL ?? 'https://www.luckyshamrock.ca';

  try {
    const db = getDb();
    const [existing] = await db.select().from(customer).where(eq(customer.email, parsed.data.email));

    if (!existing) {
      // Do not leak whether the email exists. Pretend success.
      res.status(200).json({ status: 'ok' });
      return;
    }

    const token = generateMagicLinkToken();
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

    await db.insert(magicLinkToken).values({
      token: tokenHash,
      customerId: existing.id,
      expiresAt,
    });

    const manageUrl = `${siteUrl}/api/magic-link/verify?token=${encodeURIComponent(token)}`;
    const rendered = magicLinkTemplate({ manageUrl });

    // Detach the email send so both branches return after the same fast DB
    // work — awaiting the Gmail round-trip ONLY in the email-exists branch is a
    // timing oracle that reveals which addresses are customers. BUT a bare
    // `void promise` dies on Vercel: the lambda freezes the moment the response
    // is sent, killing the in-flight send (found live 2026-06-10 — every
    // magic-link email was silently dropped). waitUntil() keeps the function
    // alive until the promise settles without delaying the response.
    waitUntil(
      sendAndLog({
        kind: 'magic_link',
        to: parsed.data.email,
        subject: rendered.subject,
        body: rendered.text,
        html: rendered.html,
        customerId: existing.id,
        visitId: null,
      }).catch((err) => console.error('[magic-link/send] email failed', err)),
    );

    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('[magic-link/send] failed', err);
    res.status(500).json({ status: 'error', message: 'Something went wrong on our end. Please try again.' });
  }
}
