# Changelog

One version number covers the whole dashboard: the page and the local server (`local/server.mjs`) read it from `version.json`. If the page and the server disagree, the page says so: restart `start.cmd`.

## 1.5.0 — 2026-10-09
- The dashboard is markets only: removed the Routes, Limits and streaming, Fees and orders, and Getting started tabs and the API summary tiles.
- Renamed to Novig Markets.
- Version numbers: shown next to the title, in the footer and in the server window, with this changelog.
- The page warns when your local server is running a different version than the page.

## 1.4.1 — 2026-10-09
- Live server stays within Novig's stream token limit (512 tokens, refilling 4/s; 16 per live book, 32 per connection): starts cautiously, backs off on a 429, spaces reconnects, and keeps subscriptions when you switch views instead of re-adding them.
- The status line shows how many markets are still waiting to join the stream.

## 1.4.0 — 2026-10-09
- Tennis match page: only Moneyline, Spread and Total. Spread and Total show the line(s) with the tightest width; the rest are under "Other lines". Every line shows its width.

## 1.3.0 — 2026-10-09
- Gaps view: scans the league and lists markets whose gap (1 − both best bids) is over the threshold, widest first.
- Gap chip on every game row; adjustable "Gap over" threshold (default 0.5¢).
- Update every second: streamed markets update instantly; everything else is refreshed oldest first within the rate limit.

## 1.2.0 — 2026-10-09
- Live mode with your own key: `local/server.mjs` signs requests and streams order books over Novig's websocket to the page at http://localhost:8787.
- `make-read-key.cmd` turns a management key into a read-only key.
- Diagnostics page (`/local/diag`), clear errors in the server window, and a fallback to public prices when a key is refused.

## 1.1.0 — 2026-10-09
- Markets tab: live prices from Novig's public order books, by league, with full order books per market.

## 1.0.0 — 2026-10-09
- First version: an explorer for Novig's v3 API, published on GitHub Pages.
