# makefun-token-radar-01

Token Launch Radar — a make.fun token-radar-01 entry. It ranks pre-token DeFi protocols by implied token value and shows how to farm each one.

## How it works

`main.ts` (Node 22, standard library only) reads the sealed snapshot at `/input/snapshot.json`, scores every rankable pre-token protocol with the radar-2 model in `lib/model.ts`, and writes:

- `/output/board.json` — 198 ranked rows (slug, name, rank, implied value in USD, 6 concrete farm steps with costs and times each)
- the dashboard data beside the page, plus copies of `dashboard/` and `screenshots/`
- `/output/dossier.json` — built with `buildDossier` from `vendor/makefun-board.ts`

## The model (radar-2)

Implied value = TVL × a size-decaying multiple × a clamped 7-day-growth multiplier × a maturity multiplier. All inputs come from the snapshot's own figures — no hardcoded list of names:

- **Multiple:** `clamp(0.55 × (10M / TVL)^0.15, 0.06, 0.55)`, anchored to the snapshot itself: its live-token protocols trade at a median market-cap/TVL of ~0.21.
- **Growth:** `1 + clamp(change_7d, −50, 100) / 100 × 0.6`.
- **Maturity:** `0.7 + 0.3 × min(age_days, 1460) / 1460` (unknown age = 365 days).

Rank 1 is Steakhouse Financial at $522,281,572. All 40 watchlist protocols appear on the board, alongside the other 158 rankable pre-token protocols. Wrapped/staked/bridged products and CEX/versioned names are excluded, so the board is genuinely pre-token; 24 live-token protocols are shown apart with their market caps.

## Dashboard

`dashboard/` (index.html + app.css + app.js, 31,431 bytes total, no network) is a dark-theme board with sortable columns, search, category/chain filters, a watchlist-only toggle, pre-token/live tabs, a highlights strip, and a detail dialog that recomputes a row's implied value and confirms it matches `board.json`.

## Run it

```sh
node main.ts --input /path/to/snapshot.json --output /path/to/output
```

Local validation against the kit snapshot passes all seven gate checks (dashboard files, board file, sorted by value, watchlist coverage 40/40, farm steps, screenshots, dossier matches), and two separate runs produce byte-identical `board.json` and `dossier.json`.

## License

MIT — see `LICENSE`.
