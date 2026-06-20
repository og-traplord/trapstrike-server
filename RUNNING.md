# Running TrapStrike Backend

Monorepo (pnpm workspace). Requires Node ≥ 20. pnpm via corepack:

```bash
corepack pnpm install
```

## Verify (any milestone)

```bash
corepack pnpm test        # unit tests (protocol round-trip + shared sim)
corepack pnpm typecheck   # tsc strict, whole monorepo
```

## Milestone 1 — authoritative room + tick loop

One-command demo (spawns the server + two clients that move in different
directions, runs ~5s, prints each client seeing the other move, then exits):

```bash
corepack pnpm demo
```

Or run the pieces manually in three terminals:

```bash
# terminal 1 — server (30 Hz sim, 20 Hz snapshots) on ws://127.0.0.1:8080
corepack pnpm server

# terminal 2 — client A, moves +X
corepack pnpm client -- --name A --dir x

# terminal 3 — client B, moves +Z
corepack pnpm client -- --name B --dir z
```

What to look for:

- The `[server]` line prints `rate=30.0Hz` every second (steady fixed-step).
- Each client prints `self=(x,z)` changing, and `peers=[…]` showing the OTHER
  client's server-authoritative position changing too.
- `ack=` climbs — the server is acking each client's input `seq` (sets up M2).

Client flags: `--name`, `--url ws://host:port`, `--duration <ms>`,
`--dir circle|x|z`, `--lat <ms>`, `--jitter <ms>`, `--drop <0..1>`.

## Milestone 2 — client prediction + reconciliation

The client now predicts its own player locally (same `packages/shared` sim) and
reconciles to server truth at `ackSeq`, replaying still-unacked inputs. Run it
under simulated network conditions:

```bash
corepack pnpm demo:m2          # 80 ms latency, 20 ms jitter, 5% drop
# or tune it:
LAT=120 JITTER=0 DROP=0 corepack pnpm demo
```

What to look for in each client's `DONE` summary line:

- `pred=` advances every tick and **leads** `srv=` by `lead≈1.0–1.4 m` — local
  movement is immediate while the server truth trails by the network delay. That
  lead is latency being *hidden*, not rubber-banding.
- `correction(avg/max)` stays tiny: ~**0.01 m avg** under pure latency (worst
  case ~0.2 m = a single tick, infrequent), a few cm even with 5% drop + jitter.
  Near-zero correction = prediction matches authority = no visible rubber-band.
- `peers=[…]` still shows the OTHER player's server-authoritative position — the
  client sends intent only; the server still owns every result.

Single predicting client against a manual server:

```bash
corepack pnpm server
corepack pnpm client -- --name A --dir x --lat 80 --drop 0.05
```

## Milestone 3 — entity interpolation

Remote players are now buffered and rendered ~100 ms in the past, interpolated
between the two bracketing snapshots (a 60 Hz render clock eased to stay behind
the newest sample). A missing snapshot is bridged by the lerp; running past the
newest sample extrapolates briefly then holds — never a hard snap.

```bash
corepack pnpm demo:m3          # 80 ms lat, 30 ms jitter, 10% drop
```

Each client's `DONE` block prints a per-peer **render-step** comparison of the
interpolated path vs the raw latest-snapshot value sampled at render rate (what
you'd draw *without* interpolation):

- `INTERP burstiness(max/avg)≈1.5`, `zero≈2–3%` → near-uniform per-frame motion,
  almost never frozen = smooth.
- `RAW burstiness≈10–12`, `zero≈73%` → frozen ¾ of frames then ~1 m snaps =
  the 20 Hz stutter interpolation removes.
- Both have the same `avg` step (same ground covered); only the smoothness
  differs. Holds up under 10% packet drop (gaps are bridged).

## Milestone 4 — lag-compensated hit registration

The client expresses fire **intent** only: it aims at the target it currently
sees (interpolated) and stamps `fireTick` = the server tick it's interpolating
at. The server rewinds every hitbox to that tick (1 s position-history ring),
resolves the ray, validates fire-rate + ammo + line-of-sight, and emits
`HIT`/`KILL` on the **reliable** channel. The client never decides a hit.

```bash
corepack pnpm test            # 29 tests incl. lag-comp/fire-rate/LOS
corepack pnpm demo:m4         # 80 ms lat + 5% drop, clients shoot each other
```

What to look for:

- `EVENT HIT 1→2 dmg=34 victimHp=66 … 32 … 0` then `EVENT KILL` then
  `EVENT SPAWN` — hits land on *moving* targets under latency (lag comp), damage
  accrues, death + respawn work, and events reach both clients.
- The definitive lag-comp proof is the unit test `combat.test.ts` →
  *"a shot aimed where the target WAS hits only when rewound"* (hit with rewind,
  miss without). Fire-rate cooldown and wall-LOS blocking are unit-tested too.
- `selfCorrection max` can spike (~7 m) exactly once per death — that's the
  authoritative **respawn teleport** snapping prediction, not rubber-banding.

Single firing client vs a manual server:

```bash
corepack pnpm server
corepack pnpm client -- --name A --dir x --lat 80 --fire
```

## Milestone 5 — WebTransport (with WebSocket fallback)

The server now listens on **both** WebSocket (TCP) and WebTransport (QUIC/UDP) on
the same port, feeding one Match. Clients try WebTransport first and fall back to
WebSocket automatically. Mapping (behind the same `Transport` interface, no
game-logic change):

| logical channel | WebTransport | WebSocket |
|---|---|---|
| snapshots (unreliable) | datagrams | binary frame |
| InputCmd (unreliable) | datagrams | binary frame |
| events (reliable) | unidirectional stream, length-framed | binary frame |
| welcome (control) | reliable stream, tag `0x11` | text frame |

Requirements: a real **OpenSSL** (not macOS LibreSSL — QUIC/BoringSSL rejects its
certs). `dev-cert.ts` auto-detects `/opt/homebrew/bin/openssl` etc.; override with
`OPENSSL=/path/to/openssl`. A self-signed ECDSA P-256 dev cert is minted into
`.wt-dev-cert/` and trusted via its SHA-256 hash (no CA install).

```bash
corepack pnpm demo:m5      # clients connect over WebTransport (QUIC)
corepack pnpm demo:m5-ws   # FORCE_WS=1 → same gameplay over the WebSocket fallback
```

What to look for: `connected via WT` (or `WS`) on both server and clients, and the
same HIT/KILL/SPAWN combat flowing either way. The QUIC reliable stream carries
events; datagrams carry snapshots/inputs. `pnpm test` stays at 29/29 — sim,
protocol, and Match are untouched; only the transport layer changed.

To run the server alone (both transports):

```bash
corepack pnpm server                 # ws://127.0.0.1:8080 (+ WebTransport)
WT=0 corepack pnpm server            # WebSocket only
```

## Milestone 6 — match-manager + matchmaking + deploy

The **match-manager** runs a matchmaking queue (Redis in prod, in-memory locally),
groups `MATCH_SIZE` players, spawns one **game-server process per match** on a
free port, hands clients their assignment, and reaps the process (frees the port)
when the match ends. The game-server runs a lifecycle: **WARMUP → LIVE (rounds) →
END → exit** (only when `LIFECYCLE=1`; M1–M5 stay endless) and binds `0.0.0.0`.

Headless flow (no Docker/Redis needed — uses the in-memory queue):

```bash
corepack pnpm demo:m6     # manager + 10 clients → 1 match → play → reap
```

Expected: `ALLOC … players=10` → `lifecycle LIVE players=10` → `ROUND 1/2 … 2/2` →
`END` → `match complete — exiting` → `REAP … freePorts=20` → `✓ … reaped & port freed`.

Run the pieces:

```bash
REDIS_URL=redis://127.0.0.1:6379 corepack pnpm mm   # manager (omit REDIS_URL → in-memory)
corepack pnpm mm-client -- --name P1 --manager http://127.0.0.1:9000 --fire
# API: POST /queue → {ticket};  GET /assignment/:ticket → {state, assignment?};  GET /health
```

Docker stack (single VPS) — `infra/`:

```bash
cd infra && docker compose up --build      # redis + manager (+ spawned game-servers) + caddy(TLS)
```

The compose publishes the game-server port range for **both** TCP (WebSocket) and
UDP (WebTransport); Caddy fronts the matchmaking API with TLS. Set `PUBLIC_HOST`
to the address clients use. (This stack is written for a real box; it was not run
in the dev sandbox — no Docker there.)

## Layout

```
packages/shared/        deterministic sim + quantization + raycast (both ends)
packages/protocol/      InputCmd + Snapshot + Event binary encode/decode
packages/game-server/   one match = one process: transports, jitter buffer, combat,
                        lag comp, round lifecycle
packages/match-manager/ matchmaking queue + process-per-match allocator (M6)
test-client/            headless driver, demos, mm-client
infra/                  Dockerfile + docker-compose + Caddyfile (single-VPS stack)
```

Docs: `CLAUDE.md` (rules), `ARCHITECTURE.md`, `MILESTONES.md`, `PROTOCOL.md`.
