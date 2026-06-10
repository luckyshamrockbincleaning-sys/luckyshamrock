/* Single source of truth for CLIENT-side display prices, in DOLLARS.
   Mirrors lib/pricing.ts (the server source, in cents). The drift guard
   lib/_tests/pricing-sync.test.ts fails the build if these disagree with the
   server, so a price change can never land in one place and not the other.
   Loaded as a plain <script> before the Babel components on the storefront;
   components read window.LS_PRICING (with an inline fallback in case it
   somehow fails to load). */
window.LS_PRICING = {
  oneoff: 45, // one-off clean, first bin
  monthly: 35, // monthly plan, per clean, first bin
  seasonalSeason: 105, // Three Wash Season — whole season, first bin
  seasonalPerWash: 35, // billed per wash (105 / 3)
  extraBinPerClean: 12, // each additional bin, per clean
};
