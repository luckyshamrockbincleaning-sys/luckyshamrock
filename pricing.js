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

/* Which bins a customer can pick, in the SAME canonical order as
   lib/bin-types.ts (BIN_TYPES). Order matters beyond looks: photos and the
   per-bin email sections are keyed by position, so "bin 1" has to mean the
   same bin every visit. lib/_tests/bin-types-sync.test.ts fails the build if
   this drifts from the server list. Shared by the storefront booking form and
   the /ops walk-up form. */
window.LS_BIN_TYPES = [
  { value: 'garbage', label: 'Black · garbage', swatch: '#3a3a3c' },
  { value: 'organics', label: 'Green · organics', swatch: '#2f7d32' },
];

// Business launch day — cleans can't be scheduled before this. The booking
// calendar, schedule previews, and the site banner all read it; it becomes
// inert once the date passes.
window.LS_LAUNCH_DATE = '2026-07-23';
