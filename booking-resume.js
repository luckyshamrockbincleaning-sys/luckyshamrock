/* Keeps a half-finished booking alive across a full-page navigation.
 *
 * The booking form is a single React component tree holding everything the
 * customer typed — contact details, plan, bins, chosen day, and the Stripe
 * ids returned by the payment_setup step. A full page load destroys all of
 * it, and there are two ordinary ways that happens between "card saved" and
 * "booking submitted":
 *
 *   1. The issuer demands a full-page 3-D Secure challenge. Stripe navigates
 *      the whole page to the bank and back. The SetupIntent succeeds, so the
 *      card is saved and a Stripe customer exists — but /api/book is never
 *      called, so there is NO booking in our database. The customer lands on
 *      an empty form believing they have booked, and Shea never sees the job.
 *   2. The phone reloads the tab on its own. Android already does this to the
 *      /ops tab when the camera opens (see ops/components-ops.jsx).
 *
 * sessionStorage rather than localStorage: an abandoned booking should not
 * outlive the tab. The stored blob carries no card data — only the Stripe ids,
 * which api/book.ts independently re-verifies against Stripe before it will
 * accept them (see getSavedPaymentMethodFromSetupIntent).
 */
(function (w) {
  var KEY = 'ls-booking-resume';
  var TTL_MS = 30 * 60 * 1000;

  function store() {
    // Private browsing and blocked storage both throw on access, not on use.
    try { return w.sessionStorage; } catch (e) { return null; }
  }

  w.LS_BOOKING_RESUME = {
    KEY: KEY,
    TTL_MS: TTL_MS,

    save: function (state) {
      var s = store();
      if (!s) return;
      try { s.setItem(KEY, JSON.stringify({ ts: Date.now(), state: state })); } catch (e) {}
    },

    load: function () {
      var s = store();
      if (!s) return null;
      try {
        var raw = s.getItem(KEY);
        if (!raw) return null;
        var data = JSON.parse(raw);
        if (!data || !data.ts || !data.state) return null;
        // A stale booking is worse than none: prices, the season and the
        // calendar all move, and resuming into them would confirm something
        // the customer never actually chose.
        if (Date.now() - data.ts > TTL_MS) return null;
        return data.state;
      } catch (e) {
        return null;
      }
    },

    clear: function () {
      var s = store();
      if (!s) return;
      try { s.removeItem(KEY); } catch (e) {}
    },

    /* Stripe appends setup_intent + redirect_status to the return_url after a
     * full-page authentication. Their presence is the only reliable signal
     * that this page load is a return from the bank rather than a fresh
     * visit. Parsed by hand so an ordinary visit with marketing query params
     * is never mistaken for one. */
    pendingFromUrl: function (search) {
      if (typeof search !== 'string' || search.length === 0) return null;
      var params = {};
      search.replace(/^\?/, '').split('&').forEach(function (pair) {
        if (!pair) return;
        var i = pair.indexOf('=');
        var k = i === -1 ? pair : pair.slice(0, i);
        var v = i === -1 ? '' : pair.slice(i + 1);
        try { params[decodeURIComponent(k)] = decodeURIComponent(v); } catch (e) {}
      });
      if (!params.setup_intent || !params.redirect_status) return null;
      return { setupIntentId: params.setup_intent, status: params.redirect_status };
    },
  };
})(typeof window !== 'undefined' ? window : this);
