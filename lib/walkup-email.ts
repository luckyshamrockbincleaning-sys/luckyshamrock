/**
 * Walk-up customers who decline to give an email get a minted
 * `walkup+<8hex>@luckyshamrock.ca` placeholder so the customer.email
 * NOT NULL/UNIQUE constraints still hold (see handleNewJob in
 * operator-handlers.ts). Those addresses receive no customer email — this is
 * the single guard both send paths check.
 *
 * Deliberately its own tiny module (not exported from operator-handlers.ts):
 * operator-handlers.ts transitively pulls in sharp, gifenc, and the ~947 KB
 * leprechaun-sprites.ts. billing-webhook.ts is the Stripe webhook's serverless
 * function and must not bundle any of that just to check an email pattern.
 */
export function isPlaceholderEmail(email: string): boolean {
  return /^walkup\+[0-9a-f]{8}@luckyshamrock\.ca$/i.test(email);
}
