# Novig v3 API Explorer

An unofficial, single-page explorer for [Novig's v3 exchange API](https://docs.novig.com/): every route with its key scope, throttle bucket and token cost, plus throttle limits, websocket channel weights, fee schedules with a fee calculator, the price grid, order types, environments and the quickstart.

The **Markets** tab shows live prices from Novig's public, keyless routes (`api.novig.com/v3/public`): pick a league, see each game's moneyline, and open any event for all its markets and full order books. It paces itself to the public rate limit (about 2 requests a second per IP). `markets.js` holds that code.

Plain HTML, CSS and JavaScript. No build step and no dependencies, so it runs anywhere that serves static files, including GitHub Pages.

## Run it locally

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

Opening `index.html` straight from disk won't work, because browsers block `fetch` of local files.

## Where things live

| File | What's in it |
| - | - |
| `data/routes.json` | All 46 routes: method, path, name, group, key scope, throttle, cost, notes, docs link |
| `data/throttle.json` | Token buckets: capacity and refill rate |
| `data/ws_channels.json` | Websocket channels and their token weight |
| `data/fees.json` | Fee schedules: coefficient, maker credit, when charged |
| `data/tif.json` | Order types (time in force) |
| `data/price_grid.json` | Submittable price bands and steps |
| `data/environments.json` | Paper and Production hosts |
| `data/quickstart.json` | The five quickstart calls |
| `data/public_data.json` | Novig's free daily CSV files |
| `data/hard_limits.json` | Caps on keys, batches, connections and signing |
| `data/meta.json` | The "last updated" date in the footer |
| `index.html` | Page layout and the static text |
| `style.css` | Look and feel, light and dark themes |
| `app.js` | Draws everything from the data files |

Most changes to the content are edits to one JSON file. Every number on the page (tiles, counts, refill times, fee check values) is worked out from these files, so they stay consistent.

## Publishing

GitHub Pages serves the repository root from the `main` branch. Every push to `main` updates the live site within a minute or two.

Compiled from docs.novig.com. Not affiliated with Novig.
