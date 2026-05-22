# Lucky Shamrock — Residential Bin Cleaning

Marketing site for Lucky Shamrock Bin Cleaning (Fort Saskatchewan).

Static React site rendered via Babel-standalone in the browser — no build step.

## Run locally

Any static server works:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## Structure

- `index.html` — entry, loads React + Babel UMD and the JSX components
- `app.jsx` — root `App` component, palette + tweaks wiring
- `components-*.jsx` — page sections (core/mid/booking/footer)
- `tweaks-panel.jsx` — in-page edit panel for brand details and palette
- `styles.css` — all styling
- `assets/` — logo + mascot images
- `uploads/` — additional imagery
- `index-print.html` — print-friendly variant

## Editable in-browser

The Tweaks panel (bottom right of the page) lets you change city, phone,
and palette without editing code. Defaults live in `app.jsx` inside the
`EDITMODE` block.
