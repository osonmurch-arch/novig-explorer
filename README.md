# Novig Markets

An unofficial live dashboard for [Novig](https://novig.com)'s order books: moneylines, spreads and totals by league, a **Gaps** view of markets whose width (1 − both best bids) is over a threshold, and a tennis match page that shows the tightest lines first. Without a key it reads Novig's public order books; with your own read-only key (below) it streams them live.

Plain HTML, CSS and JavaScript, no build step. `version.json` holds the version; see [CHANGELOG.md](CHANGELOG.md).

| File | What's in it |
| - | - |
| `index.html`, `style.css` | The page and its look (light and dark) |
| `markets.js` | The dashboard: loading, prices, gaps, tennis layout, live updates |
| `app.js` | Theme toggle and version display |
| `version.json` | The version, shared by the page and the local server |
| `local/` | The optional live server for your own key |

## Live mode with your own key (optional)

`local/` holds a small server you run on your own computer. It signs requests with your **read-only** Novig key, opens one websocket to Novig, and streams live order books to the Markets tab at `http://localhost:8787`. Your key never leaves your computer and is never committed (see `.gitignore`).

1. Install Node.js 22 or newer (`winget install OpenJS.NodeJS.LTS` on Windows).
2. Double-click `local/start.cmd` (or run `node local/server.mjs`). The first run creates `local/config.json` and opens it.
3. Fill in `keyId` (your `trading::read` key ID) and `keyFile` (the path to that key's `.pem`), save, and start it again.

Only have the management key from novig.com (Profile → Settings → Novig API)? Put it in `config.json`, then double-click `local/make-read-key.cmd`. It uses that key once to create a read-only key on a subaccount (opening one if you have none; no money moves), saves it beside your management key, and switches `config.json` to it.

It only forwards read-only routes: nothing that places orders or moves money. Novig's location check applies: no VPN, a state Novig serves, and a recent geolocation from the Novig app on your phone.

## Publishing

GitHub Pages serves the repository root from the `main` branch. Every push to `main` updates the live site within a minute or two.

Compiled from docs.novig.com. Not affiliated with Novig.
