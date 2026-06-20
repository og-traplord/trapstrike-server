# TrapStrike Backend — Project Rules

This file is persistent context. Read it before every task. These rules are
**non-negotiable** — if a request seems to conflict with them, stop and ask.

## What we're building
The authoritative multiplayer backend for **TrapStrike**, an existing
browser-based 5v5 FPS (WebGL/JS client). We are building the **server**; the
game client already exists and will be wired up later.

Full design: see `ARCHITECTURE.md`. Build plan: see `MILESTONES.md`.
Wire format: see `PROTOCOL.md`.

## The five laws (never violate)
1. **Server-authoritative.** The client sends *intent only* (input commands).
   It NEVER sends positions, velocity, health, hit confirmations, or deaths.
   The server simulates the world and is the single source of truth. If you
   ever find yourself trusting a client-reported game-state value, it's a bug.
2. **Fixed-step simulation @ 30 Hz.** One deterministic loop using an
   accumulator. Never tie simulation to render/frame timing.
3. **Snapshots @ 20 Hz, binary, delta-compressed.** No JSON in the gameplay
   hot path. JSON is allowed only for lobby/matchmaking REST endpoints.
4. **One process per match (room model).** Each match holds its full world
   state in memory. No database read/write inside the tick loop. A crash must
   take down exactly one match, never the fleet.
5. **Shared deterministic sim.** Movement and collision live in
   `packages/shared` and are imported by both the server and (later) the
   browser client, so client prediction and server authority run identical code.

## Engineering constraints
- **Language:** TypeScript, strict mode, across the whole monorepo.
- **Performance:** pool objects and avoid per-tick heap allocation in the game
  loop — a GC pause is a tick hiccup. Profile if the tick rate wobbles.
- **Transport:** abstract everything behind a single `Transport` interface.
  Start with WebSocket (`ws`); WebTransport is a later drop-in, not a rewrite.
- **No premature infrastructure.** Do NOT add Postgres/accounts/persistence
  until Milestone 6. Redis appears only when matchmaking does.
- **Determinism:** fixed timestep, integer/quantized where it matters, no
  `Date.now()` inside the sim step — pass `dt` in.

## Working agreement
- Build **one milestone at a time** (see `MILESTONES.md`). Do not scaffold
  future milestones early. Stop at each milestone's acceptance criteria and let
  me verify before continuing.
- Every package gets unit tests for its pure logic (protocol encode/decode and
  the shared sim step are the priorities).
- Keep commits scoped to a milestone. Write a short note of what changed and how
  to run/verify it.
- When a decision isn't covered here or in the docs, ask rather than guess.

## Repo layout (target)
```
packages/
  shared/        deterministic sim: movement, collision, world step, constants
  protocol/      InputCmd + Snapshot binary encode/decode (shared both ends)
  game-server/   one match = one process: tick loop, jitter buffer, authority
  match-manager/ spawns/reaps game-server processes, matchmaking (Milestone 6)
test-client/     headless Node script that drives fake players for testing
infra/           Dockerfiles, docker-compose, Caddy config (Milestone 6)
```
Use a pnpm workspace monorepo.
