# techdollar-point-system

On-chain points engine for the **TechDollar (USDte)** protocol — distributes
time-weighted points to early users for four behaviours:

| Surface          | Multiplier | How USD value is measured                                 |
| ---------------- | ---------- | --------------------------------------------------------- |
| USDte hold       | **1×**     | `balanceOf(user)` of USDte (peg = $1)                     |
| sUSDte stake     | **2×**     | `balanceOf(user)` × `getExchangeRate()`                   |
| Curve LP         | **3×**     | `(lpBalance + gaugeBalance) × pool.get_virtual_price()` — full LP value, not the USDte slice |
| Morpho supply    | **3×**     | `position.assets / 1e18` from the Morpho Blue subgraph    |

The engine is written for an Express + Sequelize host app (e.g. the parent
USDte backend) but ships as a self-contained module so you can extract the
bits you need. Schema, route handlers, indexer and the proof tests all live
together.

## Status

- 5 substantive improvement passes already landed (see
  [`proving-ground/reports/20260420-205241/proof.md`](proving-ground/reports/20260420-205241/proof.md))
- 5 test suites, 40 tests, all passing — pure-function coverage of the
  accrual math, the Curve LP-valuation invariant, the diminishing-returns
  detector, the in-tree `pLimit`, and the structured `PointsError`.
- Designed to integrate with the
  [`almanac-engine`](https://github.com/0xWhereto/almanac-engine)
  autonomous improvement loop — `overnight.yaml` and `objective.yaml` at
  the repo root are valid almanac adapters / objectives.

## Quick start

```bash
git clone https://github.com/0xWhereto/techdollar-point-system.git
cd techdollar-point-system
npm install
cp .env.example .env       # fill in addresses when you have them
npm test                   # 40 tests, all DB-free, runs in <1s
```

To exercise the indexer against a live RPC + a real Curve / Morpho
deployment, set `ETH_RPC_URL`, `CURVE_POOL_ADDRESS`, `MORPHO_VAULT_ADDRESS`,
`MORPHO_MARKET_ID` in `.env`, then:

```bash
node scripts/smoke.js
```

## Architecture

```
src/points/
├── config.js              # central config + ABIs + multipliers + season dates
├── errors.js              # PointsError(code, message, { field, fixHint })
│                          #   codes: VALIDATION, NOT_FOUND, CONFLICT,
│                          #          CONFIG_MISSING, RPC_FAILURE,
│                          #          SUBGRAPH_FAILURE, IDEMPOTENCY, INTERNAL
├── curveValue.js          # pure: lpUsdValue(lpAmount, virtualPrice)
├── pLimit.js              # 15-line in-tree concurrency limiter, zero deps
├── diminishingReturns.js  # ported from almanac-engine; tells the indexer
│                          #   when to stop bothering
├── accrualEngine.js       # pure computeAccrualRows() + DB-touching wrapper
├── indexer.js             # tick loop with per-source circuit breaker
│                          #   (3 fails → 30s → 30min backoff)
├── pointsService.js       # read-side: leaderboard, address totals, exposure
├── seed.js                # idempotent seed for default sources + epochs
└── adapters/
    ├── BaseAdapter.js          # holder-set, persistSnapshots, markProgress
    ├── Erc20BalanceAdapter.js  # USDte + sUSDte (Transfer scan + balanceOf)
    ├── CurveLpAdapter.js       # LP + gauge Transfer scan, virtual_price math
    ├── MorphoVaultAdapter.js   # MetaMorpho positions via subgraph
    └── MorphoMarketAdapter.js  # Morpho Blue market positions via subgraph

src/models/                # Sequelize models for the 6 tables
src/routes/points.js       # GET /sources, /epochs, /leaderboard, /stats,
                           #     /wallet/:address, /me
                           # POST /admin/{sources,epochs,exclude,recompute,accrue}
                           # GET  /admin/health    (per-source health record)
src/middleware/auth.js     # MINIMAL auth stub — replace when integrating
src/config/database.js     # SQLite by default, Postgres via env
src/utils/logger.js        # tiny logger stub — replace with your host's

tests/points/              # 5 suites, 40 tests, all DB-free
proving-ground/            # almanac-engine adapter + objectives + proof packets
overnight.yaml             # surfaces with invariants, risk, validation cmds
objective.yaml             # current objective + evidence + stop conditions
```

## Data model

| Table                       | Role                                                                       |
| --------------------------- | -------------------------------------------------------------------------- |
| `point_sources`             | Earning surfaces. `extraConfig` (JSON) lets you paste in pool/vault addrs. |
| `balance_snapshots`         | Per-(source, address) periodic USD-value snapshot. Idempotency key = (source, address, snapshot_at). |
| `balance_events`            | Optional audit log of ERC20 Transfer events (used for holder discovery).    |
| `point_epochs`              | Seasons. `mode='simulation'` keeps pre-launch data out of the live board.   |
| `point_accruals`            | Time-weighted points per (source, address, period). UNIQUE on those three.  |
| `points_excluded_addresses` | Protocol contracts / CEX wallets / team addresses that don't earn.          |

## How accrual works

Between two consecutive snapshots S<sub>i</sub> and S<sub>i+1</sub>, the user
held `avg(S_i.usdValue, S_{i+1}.usdValue)` USD-equivalent for
`S_{i+1}.snapshotAt − S_i.snapshotAt` seconds. Points for that interval:

```
points = avgUsd × durationDays × basePointsPerUsdPerDay
              × source.multiplier × epoch.boost
```

The unique index on `(source_id, address, period_start)` makes the engine
**idempotent** — re-running over the same snapshot history is a no-op.

## Curve LP valuation (locked-in spec)

```
usdValue = lpAmount × pool.get_virtual_price()
```

The full LP value, **not** the USDte slice — locked by
[`tests/points/curveValue.test.js`](tests/points/curveValue.test.js) and
[`src/points/curveValue.js`](src/points/curveValue.js).

## Reliability primitives (borrowed from almanac-engine)

- **Per-source circuit breaker** — 3 consecutive failures trip the source,
  exponential backoff (30s → 1m → 2m → … → 30m cap). First failure logs at
  `error`; once tripped, every 10th retry logs at `warn` so a long outage
  is never silent.
- **Health record** — `{ consecutiveFailures, totalFailures,
  totalSuccesses, lastError, lastSuccessAt, lastTickAt, nextRetryAt,
  cooldownMs }` per source, exposed via `GET /api/points/admin/health`.
- **Diminishing-returns detector** — port of
  [`almanac-engine/proving-ground/lib/diminishing_returns.cjs`](https://github.com/0xWhereto/almanac-engine).
  When the indexer's last 5 ticks land < 1.0 snapshots/accruals on average,
  or there have been ≥ 5 consecutive zero-landing ticks, the detector
  signals exhaustion. Operators get a heads-up via `/admin/health`.
- **RPC concurrency cap** — `POINTS_RPC_CONCURRENCY` (default 10, hard cap
  25). Implemented in 15 lines without an npm dep.
- **Structured errors** — every failure carries `{ code, field, fixHint }`
  so a frontend or operator can act on it without parsing prose.

## Public HTTP API

Rooted at `/api/points` when wired into an Express app:

| Method | Path                       | Auth   | Purpose                                       |
| ------ | -------------------------- | ------ | --------------------------------------------- |
| GET    | `/sources`                 | none   | List earning surfaces with multipliers        |
| GET    | `/epochs`                  | none   | List seasons (simulation + live)              |
| GET    | `/leaderboard?limit&offset&mode` | none | Top addresses by total points          |
| GET    | `/stats?mode`              | none   | Total points, unique users, breakdown         |
| GET    | `/wallet/:address?mode`    | none   | Per-address totals, breakdown, rank, exposure |
| GET    | `/me?mode`                 | optional JWT | Same, scoped to req.user.walletAddress |
| GET    | `/admin/health`            | admin JWT | Indexer + per-source health record         |
| POST   | `/admin/sources`           | admin JWT | Upsert a source (paste in real Curve/Morpho addresses here) |
| PATCH  | `/admin/sources/:key`      | admin JWT | Patch source fields                        |
| POST   | `/admin/epochs`            | admin JWT | Upsert an epoch                            |
| POST   | `/admin/exclude`           | admin JWT | Add an excluded address                    |
| DELETE | `/admin/exclude/:address`  | admin JWT | Remove an excluded address                 |
| POST   | `/admin/recompute`         | admin JWT | Trigger a one-shot indexer tick            |
| POST   | `/admin/accrue`            | admin JWT | Re-run accrual over historical snapshots   |

## Almanac integration

The repo root ships with [`overnight.yaml`](overnight.yaml) and
[`objective.yaml`](objective.yaml) — valid adapter + objective for
[`almanac-engine`](https://github.com/0xWhereto/almanac-engine):

```bash
cd /path/to/almanac-engine
node scripts/run_overnight_engine.cjs validate-adapter \
  --adapter /path/to/techdollar-point-system/overnight.yaml \
  --objective /path/to/techdollar-point-system/objective.yaml

node scripts/run_overnight_engine.cjs run \
  --adapter /path/to/techdollar-point-system/overnight.yaml \
  --objective /path/to/techdollar-point-system/objective.yaml \
  --proposal-mode staged
```

The [`proving-ground/objectives-rotate/`](proving-ground/objectives-rotate)
directory is a queue of surface-diverse follow-up objectives so the loop
doesn't dogpile a single surface.

## License

UNLICENSED — internal TechDollar repository.
