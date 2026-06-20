# TrapStrike Backend — Build Milestones

Build **one milestone at a time**. Stop at each milestone's acceptance criteria
and let the human verify before starting the next. Do not scaffold future
milestones early.

Each milestone below has a **paste prompt** — the exact instruction to give the
agent for that step.

---

## Milestone 1 — Authoritative room + tick loop  ← START HERE

**Goal:** a single game-server process that simulates movement authoritatively
and broadcasts state, with a headless test client to prove it.

**Scope**
- pnpm workspace monorepo with `packages/shared`, `packages/protocol`,
  `packages/game-server`, and `test-client` (see `CLAUDE.md` layout).
- `protocol`: binary encode/decode for `InputCmd` and `Snapshot` per
  `PROTOCOL.md`, with round-trip unit tests.
- `shared`: deterministic WASD movement + a flat-plane collision stub, stepped
  by an explicit `dt` (no `Date.now()` inside).
- `game-server`: accept WebSocket (`ws`) connections; 30 Hz fixed-step loop with
  an accumulator; per-player input jitter buffer; apply inputs on tick; integrate
  via `shared`; broadcast delta snapshots at 20 Hz.
- `test-client`: connect, send inputs for 5s, print received snapshots.

**Acceptance**
- Two `test-client`s connect; each sees the other move via server snapshots.
- Logged tick rate holds steady at 30 Hz.
- No client-reported positions exist anywhere in the protocol or server.
- `protocol` round-trip tests pass.

> **Paste prompt:** Read CLAUDE.md, ARCHITECTURE.md, MILESTONES.md, PROTOCOL.md.
> Build **Milestone 1 only** as described in MILESTONES.md. Set up the pnpm
> monorepo, the protocol package with round-trip tests, the shared sim, the
> game-server with a 30 Hz authoritative loop and 20 Hz snapshots, and a headless
> test-client. Stop at the M1 acceptance criteria and tell me how to run and
> verify it.

---

## Milestone 2 — Client-side prediction + reconciliation

**Goal:** the controlled player feels zero input lag.

**Scope**
- In `test-client`, apply input locally on send (predict) using the **same**
  `shared` sim the server uses.
- On each snapshot: snap own player to the server state at `ackSeq`, then replay
  all inputs with `seq > ackSeq`.
- Add an artificial latency knob (e.g. 80 ms each way) to the test client.

**Acceptance**
- With simulated latency, local movement is immediate and converges to server
  state with no visible rubber-banding under normal play.

> **Paste prompt:** Milestone 1 verified. Build **Milestone 2**: client-side
> prediction + server reconciliation in test-client, reusing the shared sim.
> Add a simulated-latency knob. Stop at the M2 acceptance criteria.

---

## Milestone 3 — Entity interpolation

**Goal:** other players move smoothly despite 20 Hz snapshots.

**Scope**
- Buffer incoming snapshots; render remote entities ~100 ms in the past,
  interpolating between the two bracketing snapshots.
- Handle gaps (missing snapshot) gracefully — extrapolate briefly or hold.

**Acceptance**
- A second player's movement is smooth in the first client at 20 Hz snapshots,
  with no stutter, under simulated latency + occasional packet drop.

> **Paste prompt:** Milestone 2 verified. Build **Milestone 3**: entity
> interpolation (~100 ms render delay, buffered snapshots) for remote players.
> Stop at the M3 acceptance criteria.

---

## Milestone 4 — Lag-compensated hit registration

**Goal:** shooting hits what the shooter saw.

**Scope**
- Add a `fire` button to `InputCmd` and a hitscan weapon.
- Server keeps a ring buffer of per-tick entity positions (~1s).
- On a shot, rewind hitboxes to the shooter's `fireTick`, resolve the ray
  server-side, validate fire-rate, ammo, and line-of-sight. Emit `hit`/`kill`
  events on the reliable channel.

**Acceptance**
- A shot fired at a moving target on the shooter's screen registers as a hit
  server-side under simulated latency. Fire-rate and wall blocking are enforced.

> **Paste prompt:** Milestone 3 verified. Build **Milestone 4**: lag-compensated
> hitscan — fire button, per-tick position history, server-side rewind + ray
> resolve, fire-rate/ammo/LOS validation, hit/kill events on the reliable
> channel. Stop at the M4 acceptance criteria.

---

## Milestone 5 — Transport swap to WebTransport

**Goal:** UDP-like transport without rewriting gameplay.

**Scope**
- Define a `Transport` interface (if not already) and refactor the WS code behind it.
- Implement a WebTransport transport (`@fails-components/webtransport`):
  snapshots on **unreliable datagrams**, events on a **reliable stream**.
- Keep WebSocket as an automatic fallback.

**Acceptance**
- The same gameplay runs over WebTransport in a supporting browser, and over
  WebSocket where WebTransport is unavailable, with no game-logic changes.

> **Paste prompt:** Milestone 4 verified. Build **Milestone 5**: a Transport
> interface with a WebTransport implementation (datagrams for state, reliable
> stream for events) and WebSocket fallback. No game-logic changes. Stop at the
> M5 acceptance criteria.

---

## Milestone 6 — Match manager + matchmaking + deploy

**Goal:** real 5v5 matches, allocated on demand, deployable to a VPS.

**Scope**
- `match-manager`: spawn a `game-server` process per match from a port range;
  health-check and reap on match end.
- Redis-backed matchmaking queue that groups 10 players and allocates a server.
- Minimal match lifecycle: ALLOC → WARMUP → LIVE (rounds) → END → TEARDOWN.
- `infra/`: Dockerfiles + docker-compose (match-manager, Redis, Caddy for TLS),
  ready for a single VPS.

**Acceptance**
- 10 simulated clients queue, get matched, play a full match in a spawned
  process, and the process is reaped at the end. `docker compose up` runs the
  whole stack locally.

> **Paste prompt:** Milestone 5 verified. Build **Milestone 6**: match-manager
> (process-per-match from a port range), Redis matchmaking queue for 5v5, the
> match lifecycle state machine, and infra/ with Dockerfiles + docker-compose
> (manager, Redis, Caddy). Stop at the M6 acceptance criteria.

---

## After M6
- Add Postgres + accounts/auth and persistent stats/progression.
- Move to a fleet orchestrator (Agones / Hathora / Edgegap) for multi-region +
  autoscale — the game-server process stays the same.
- Behavioral anti-cheat telemetry; server-side culling of unseen entities.
