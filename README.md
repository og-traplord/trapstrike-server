# TrapStrike Multiplayer Backend — Developer Handoff

This folder is a self-contained brief for building the TrapStrike backend with
Claude Code (or any engineer). Drop it into the repo root and point the agent at it.

## What's in here
| File | Who reads it | Purpose |
|---|---|---|
| `CLAUDE.md` | Claude Code (every task) | The non-negotiable rules + repo layout. Keep at repo root. |
| `ARCHITECTURE.md` | Claude Code + you | The full system design, in prose. |
| `MILESTONES.md` | Claude Code + you | The staged build plan with acceptance criteria + ready-to-paste prompts. |
| `PROTOCOL.md` | Claude Code | Exact binary wire format for InputCmd and Snapshot. |
| `architecture-doc.html` | You (humans) | The visual architecture doc — open in a browser. |

## How to use this with Claude Code
1. Copy `CLAUDE.md` to the **root** of your new repo (Claude Code auto-reads it).
2. Copy `ARCHITECTURE.md`, `MILESTONES.md`, and `PROTOCOL.md` into the repo
   (a `/docs` folder is fine).
3. Open Claude Code in the repo and start with:

   > Read CLAUDE.md, ARCHITECTURE.md, MILESTONES.md, and PROTOCOL.md.
   > Then build **Milestone 1** only. Stop at its acceptance criteria so I can verify.

4. When M1 passes, tell it: *"Milestone 1 verified. Build Milestone 2."* — and so on.

**Why one milestone at a time?** A real-time authoritative server has subtle
correctness properties (determinism, reconciliation, lag comp). Verifying each
layer before stacking the next is how you avoid an un-debuggable pile at the end.

## The build order at a glance
1. **Authoritative room + 30 Hz tick loop** — server simulates, clients see each other.
2. **Client prediction + reconciliation** — your own movement feels instant.
3. **Entity interpolation** — other players move smoothly.
4. **Lag-compensated hit registration** — shooting hits what you aimed at.
5. **Transport swap to WebTransport** — WebSocket stays as fallback.
6. **Match manager + matchmaking + Docker deploy** — real 5v5 on a VPS.

## The headline decisions (full rationale in ARCHITECTURE.md)
- **Server-authoritative** netcode — required for a competitive, cheatable web game.
- **WebTransport** (QUIC) primary, **WebSocket** fallback — browsers can't do raw UDP.
- **Node.js + TypeScript** — so the deterministic sim is shared between client
  prediction and server authority. Go is the upgrade path if you go competitive-tick.
- **One process per match** — isolated, crash-safe, trivially scalable later.

## Deployment target
Start on a **single ~4-vCPU VPS** with Docker Compose (game servers + Redis +
Caddy for TLS), ~$20–40/mo, several concurrent matches. Scale later to a fleet
orchestrator (Agones / Hathora / Edgegap) without changing the game-server code.
