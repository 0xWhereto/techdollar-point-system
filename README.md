# techdollar-point-system

On-chain points engine for the **TechDollar (USDte)** protocol. Distributes
points to early users across **two accrual modes** — a one-shot bonus on
mint, and per-hour time-weighted accrual on capital that's actually deployed:

| # | Surface | Mode | Multiplier | What's measured |
|---|---|---|---|---|
| 1 | **USDte mint** | **one-shot** | **1×** | `mintedUsd × pointsPerMint` per `Transfer(0x0 → user)` (default 10 pts / USDte) |
| 2 | USDte hold | per-hour | 1× | `balanceOf(user)` of USDte (peg = $1) |
| 3 | sUSDte stake | per-hour | 2× | `balanceOf(user)` × `getExchangeRate()` |
| 4 | Curve LP | per-hour | 3× | `(lpBalance + gaugeBalance) × pool.get_virtual_price()` — **full LP value**, not the USDte slice |
| 5 | Morpho supply | per-hour | 3× | `position.assets / 1e18` from the Morpho Blue subgraph |

Surfaces 2–5 are time-weighted: points accrue per second (snapshotted hourly)
based on the **average** USD value held between consecutive snapshots. Surface
1 is event-based: each mint produces exactly one accrual row, anchored to the
originating tx hash so re-scanning a block range never double-counts.

The engine is written for an Express + Sequelize host app (e.g. the parent
USDte backend) but ships as a self-contained module so you can extract the
bits you need. Schema, route handlers, indexer and the proof tests all live
together.

## Status

- 5 substantive improvement passes already landed (see
  [`proving-ground/reports/20260420-205241/proof.md`](proving-ground/reports/20260420-205241/proof.md))
- 6 test suites, **65 tests**, all passing — pure-function coverage of the
  time-weighted accrual math, the mint-event accrual math, the Curve
  LP-valuation invariant, the diminishing-returns detector, the in-tree
  `pLimit`, and the structured `PointsError`.
- Designed to integrate with the
  [`almanac-engine`](https://github.com/0xWhereto/almanac-engine)
  autonomous improvement loop — `overnight.yaml` and `objective.yaml` at
  the repo root are valid almanac adapters / objectives.

## Quick start

```bash
git clone https://github.com/0xWhereto/techdollar-point-system.git
cd techdollar-point-system
npm install
cp .env.example .env                              # fill in addresses when you have them
npm test                                          # 65 tests, all DB-free, <1s
node scripts/migrate-points-mint-event.js         # idempotent, safe on fresh + existing DBs
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
│                          #   POINTS_PER_USDTE_MINTED env knob lives here
├── errors.js              # PointsError(code, message, { field, fixHint })
├── curveValue.js          # pure: lpUsdValue(lpAmount, virtualPrice)
├── pLimit.js              # 15-line in-tree concurrency limiter, zero deps
├── diminishingReturns.js  # ported from almanac-engine
├── accrualEngine.js       # pure computeAccrualRows() — TIME-WEIGHTED math
├── indexer.js             # tick loop with per-source circuit breaker
│                          #   (3 fails → 30s → 30min backoff)
│                          #   calls discoverHolders → snapshotAll →
│                          #   processEventAccruals (NEW) per source
├── pointsService.js       # read-side: leaderboard, address totals, exposure
├── seed.js                # idempotent seed for default sources + epochs
└── adapters/
    ├── BaseAdapter.js              # holder-set, persistSnapshots, markProgress
    │                               # default processEventAccruals() returns 0
    ├── Erc20BalanceAdapter.js      # USDte hold + sUSDte stake (TIME-WEIGHTED)
    ├── Erc20MintEventAdapter.js    # USDte mint (ONE-SHOT) — exports the pure
    │                               #   computeMintAccrualRow() helper for tests
    ├── CurveLpAdapter.js           # LP + gauge × virtual_price (TIME-WEIGHTED)
    ├── MorphoVaultAdapter.js       # MetaMorpho positions via subgraph
    └── MorphoMarketAdapter.js      # Morpho Blue market positions via subgraph

src/models/                # Sequelize models — point_accruals now carries
                           # accrual_type ('time_weighted' | 'mint_event')
                           # and tx_hash (NOT NULL DEFAULT '')
src/routes/points.js       # GET /sources, /epochs, /leaderboard, /stats,
                           #     /wallet/:address, /me
                           # POST /admin/{sources,epochs,exclude,recompute,accrue}
                           # GET  /admin/health    (per-source health record)
src/middleware/auth.js     # MINIMAL auth stub — replace when integrating
src/config/database.js     # SQLite by default, Postgres via env
src/utils/logger.js        # tiny logger stub — replace with your host's

scripts/migrate-points-mint-event.js   # idempotent schema bump for prod DBs
scripts/smoke.js                       # one-tick indexer probe vs live RPC

tests/points/              # 6 suites, 65 tests, all DB-free
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

### Time-weighted (hold, stake, LP, Morpho)

Between two consecutive snapshots S<sub>i</sub> and S<sub>i+1</sub>, the user
held `avg(S_i.usdValue, S_{i+1}.usdValue)` USD-equivalent for
`S_{i+1}.snapshotAt − S_i.snapshotAt` seconds. Points for that interval:

```
points = avgUsd × durationDays × basePointsPerUsdPerDay
              × source.multiplier × epoch.boost
```

`accrual_type = 'time_weighted'`, `tx_hash = ''`. Idempotency anchor: the
unique index `(source_id, address, period_start, tx_hash)` — re-running over
the same snapshot history is a no-op.

### One-shot (mint)

For each `Transfer(from = 0x0, to = user, amount)` on the USDte contract:

```
mintedUsd  = amount / 10^decimals × pegUsd
basePoints = mintedUsd × pointsPerMint           # default 10 pts / USDte
points     = basePoints × source.multiplier × epoch.boost
```

`accrual_type = 'mint_event'`, `tx_hash = '0x…'`,
`period_start = period_end = blockTime`, `duration_seconds = 0`. The same
unique index is the dedup anchor — re-scanning a block range never
double-counts because the tx hash makes each row unique.

### Both modes coexist

The two accrual types live in the same `point_accruals` table and aggregate
into the same leaderboard. The `pointsPerMint` knob is a per-source field
(`extraConfig.pointsPerMint`) so you can rebalance the mint bonus per
season without a migration.

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
