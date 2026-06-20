# TrapStrike Backend — Architecture

The authoritative multiplayer backend for a browser-based 5v5 FPS.

---

## 1. The constraint

A browser FPS removes the easy netcode options that native games rely on:

- **No raw UDP.** Browsers expose only WebSocket, WebRTC DataChannels, and
  WebTransport. We must build UDP-like behavior on top of one of them.
- **Never trust the client.** JavaScript is fully inspectable. Positions, hits,
  and deaths must be decided on the server or the game is cheated immediately.
- **Hide latency, don't remove it.** You can't beat the speed of light, so the
  client predicts and interpolates to make ~60 ms RTT feel instant.

Result: a **thin-client / fat-server** split. The browser renders, samples
input, and predicts. The server is the single source of truth — everything the
player sees is provisional until a snapshot confirms it.

---

## 2. System topology

```
CLIENT (browser, WebGL)
  renderer · input sampler · prediction · interpolation buffer
        │  InputCmd ▲        ▼ Snapshot
TRANSPORT
  WebTransport (QUIC/UDP)  ·  WebSocket fallback (TCP)
        │
GAME SERVER  (1 process per match, authoritative, 30 Hz)
  connection handler · input jitter buffer · authoritative sim
  · lag-comp rewind · snapshot/delta encoder
        │
ORCHESTRATION                 STATE
  match manager (spawns a       Redis: sessions, presence, MM queue
  server per match) ·           Postgres: accounts, stats (optional)
  matchmaker / lobby
```

**Room model:** each match is its own process holding the full world state in
memory. No shared game state, no DB in the loop — a crash kills one match only.

---

## 3. Transport layer

Recommendation: **WebTransport primary, WebSocket fallback.**

|  | WebSocket | WebRTC Data | **WebTransport** |
|---|---|---|---|
| Underlying | TCP | UDP (SCTP) | UDP (QUIC/HTTP3) |
| Unreliable mode | No | Yes | **Yes (datagrams)** |
| Head-of-line blocking | Yes (stalls) | No | **No** |
| Setup cost | Trivial | Painful (SDP/ICE) | Moderate |
| Browser support | Universal | Universal | Modern (no Safari yet) |

The problem with TCP/WebSocket is **head-of-line blocking**: one dropped packet
stalls everything behind it, which for state updates means a freeze. You want to
drop stale state and keep moving.

**WebTransport** gives UDP-like *datagrams* for snapshots (drop the stale ones)
plus *reliable streams* for events (kills, chat) over one QUIC connection — no
SDP/ICE dance like WebRTC.

**Pragmatic path:** abstract transport behind one interface and **ship WebSocket
first**. At a few concurrent matches and 30 Hz it's completely fine. Swap in
WebTransport once gameplay is solid; Safari users stay on WS.

---

## 4. Netcode model

The canonical Valve/Quake model, adapted for the browser. Four techniques, each
solving one symptom of latency:

- **Client-side prediction (your player):** apply your own input the instant you
  press it — don't wait for the server. Movement feels 1:1.
- **Server reconciliation (your player):** the server snapshot is truth. On
  arrival, snap to it and *replay* every input the server hasn't acked yet.
  Mispredictions self-correct invisibly.
- **Entity interpolation (other players):** render everyone else ~100 ms in the
  past, blending between buffered snapshots — smooth motion, no stutter.
- **Lag compensation (hit registration):** when you fire, the server *rewinds*
  every hitbox to where it was on your screen at trigger-time, then checks the
  ray. You hit what you aimed at.

**Lifecycle of one input → one frame:**
1. CLIENT samples input, tags it `seq = N`, applies locally (predict), renders now.
2. → sends `InputCmd` over the wire (~½ RTT).
3. SERVER buffers in jitter buffer, then on the next tick validates, simulates,
   rewinds hitboxes for shots, resolves the world.
4. → broadcasts delta snapshot with `ack = N`.
5. CLIENT reconciles own player (replay inputs > N), interpolates others. Repeat
   ~20×/second.

---

## 5. Server tick loop

Each match process runs one fixed-step loop at **30 Hz** (accumulator for
determinism) and broadcasts snapshots at **20 Hz**.

```ts
const DT = 1000 / TICK_HZ;            // 1000/30
let acc = 0, last = now(), tick = 0;

function frame() {
  const t = now(); acc += t - last; last = t;
  while (acc >= DT) { step(DT); acc -= DT; }   // catch up, never drift
  setImmediate(frame);                          // + a precise timer in prod
}

function step(dt: number) {
  const cmds = drainInputBuffer(tick);          // 1 ingest
  for (const p of players)
    applyInput(p, cmds[p.id], dt);              // 2 validate + apply
  world.integrate(dt);                          // 3 physics
  resolveShots(cmds);                           // 4 rewind + hitreg
  if (tick % SNAP_EVERY === 0)                  // 5 + 6 @ 20 Hz
    for (const p of players) send(p, buildDelta(p));
  tick++;
}
```

Six stages per tick: **ingest → apply → integrate → resolve → snapshot → send.**

---

## 6. Packet design

Two binary packets in the hot path (see `PROTOCOL.md` for exact layout). JSON is
for matchmaking/lobby only, never gameplay.

- **InputCmd (client → server)** — every frame, ~10 bytes, sequence-numbered.
- **Snapshot (server → client)** — 20 Hz, delta-compressed against the client's
  last acked tick, bit-packed with quantized floats. For 10 players that's a few
  KB/s each. Sent unreliably; a dropped snapshot is replaced by the next one.
  Events (hit/kill/spawn) ride a reliable stream.

---

## 7. Anti-cheat = authority

Because the client only sends intent and the server owns all state, most cheats
are structurally impossible. Every tick the server enforces:

- **Movement bounds** — clamp to max speed; reject teleports / out-of-collision.
- **Fire-rate & ammo** — server-side cooldowns and magazine counts.
- **Line-of-sight on hits** — the rewound ray must actually reach the target.
- **Input rate limiting** — drop floods; reject impossible timestamps / seq gaps.

Honest limit: aimbots/wallhacks read what the client legitimately renders, so
authority alone can't stop them. That's a later layer (behavioral telemetry,
culling unseen data). Not needed at hobby scale — just don't architect it out.

---

## 8. Match lifecycle

A match is an **ephemeral process**:

```
ALLOC → WARMUP → LIVE (rounds loop) → END → TEARDOWN
spawn   players    tick loop runs      tally  process exits,
+ port  connect    rounds loop         stats  port freed
```

The Match Manager spawns a fresh game-server process when 10 players are
matched, hands them its address, and reaps it when the match ends. Ephemeral
processes mean zero state-cleanup bugs and safe restarts.

---

## 9. Tech stack

- **Game server:** Node.js + TypeScript. Decisive reason: client prediction and
  server authority must run the *same* simulation, so sharing the movement +
  collision module (TS) between browser and server gives prediction parity. Go
  is the upgrade if you later need higher tick rates or many players per box.
- **Transport:** `@fails-components/webtransport` (QUIC) + `ws` (fallback),
  behind one interface.
- **Serialization:** custom bit-packing or FlatBuffers in the hot path.
- **State/infra:** Redis for sessions, presence, matchmaking queue. Postgres for
  accounts/stats — add only when persistence is needed.

**Caveat — GC:** a garbage-collection pause can cause a tick hiccup. At 30 Hz
with a few matches per box it's a non-issue if you pool objects and avoid
per-tick allocation. Pushing to 60–128 Hz competitive play is when you'd port
the sim to Go/Rust — the network model above doesn't change.

---

## 10. Deploy & scale

**Now (hobby):** one ~4-vCPU VPS, everything in Docker Compose — Match Manager +
N game-server processes, Caddy/nginx for TLS + WebSocket, a UDP port range for
WebTransport, one Redis container. ≈ $20–40/mo, several concurrent matches.

**Later (scale):** Agones on Kubernetes or managed Hathora/Edgegap for
allocation + autoscaling + multi-region; dedicated matchmaker + Postgres. The
game-server process is unchanged — only allocation moves.
