# TrapStrike Backend — Wire Protocol

Binary, little-endian, bit-/byte-packed. Used in the gameplay hot path only.
JSON is allowed for lobby/matchmaking REST, never here.

> These layouts are a starting contract, not sacred. Keep them tight and
> documented; if you change a field, update this file and bump `PROTOCOL_VERSION`.

```
PROTOCOL_VERSION = 1
```

Every packet starts with a 1-byte type tag:

```
0x01  InputCmd     (client → server)
0x02  Snapshot     (server → client)
0x03  Event        (server → client, reliable channel)
0x10  Hello/Join   (client → server, handshake — may be JSON pre-game)
0x11  Welcome      (server → client, assigns playerId, tickRate, mapId)
```

---

## InputCmd  (client → server) — sent every client frame

Tiny and frequent. Sequence-numbered so the server can ack and the client can
reconcile. Target ~10 bytes.

| Field | Type | Notes |
|---|---|---|
| `type` | u8 | `0x01` |
| `seq` | u16 | monotonically increasing; used for ack/reconcile (wraps) |
| `dtMs` | u8 | client frame delta, clamped 1–255 |
| `moveX` | i8 | wish-direction X, −127..127 (normalized client-side) |
| `moveZ` | i8 | wish-direction Z, −127..127 |
| `yaw` | u16 | quantized 0..65535 → 0..2π |
| `pitch` | i16 | quantized, clamped to look limits |
| `buttons` | u8 | bitfield (see below) |
| `fireTick` | u32 | *(present only if FIRE bit set)* client tick at trigger, for lag comp |

**buttons bitfield**
```
bit 0  FIRE
bit 1  JUMP
bit 2  CROUCH
bit 3  RELOAD
bit 4  USE
bit 5  ADS (aim)
bit 6-7 reserved
```

The server **validates** every InputCmd: clamp `dtMs`, reject impossible `seq`
gaps/floods, ignore `FIRE` if the weapon is on cooldown, etc.

---

## Snapshot  (server → client) — broadcast at 20 Hz, unreliable

Delta-compressed against the client's last acknowledged tick. Only changed
fields per entity are sent. Sent on an **unreliable** datagram — a dropped
snapshot is simply superseded by the next.

| Field | Type | Notes |
|---|---|---|
| `type` | u8 | `0x02` |
| `tick` | u32 | server tick this snapshot represents |
| `ackSeq` | u16 | last InputCmd `seq` the server processed for THIS client |
| `entCount` | u8 | number of entity records following |
| `entities[]` | … | repeated entity records (below) |

**Entity record** (delta — presence of a field is driven by `flags`)
| Field | Type | Notes |
|---|---|---|
| `id` | u16 | entity id |
| `flags` | u16 | which fields are present + state bits (below) |
| `pos` | 3 × i16 | quantized world position (if POS bit) |
| `vel` | 3 × i16 | quantized velocity (if VEL bit) |
| `yaw` | u16 | quantized (if YAW bit) |
| `hp` | u8 | 0..100 (if HP bit) |
| `state` | u8 | enum: alive/dead/respawning/… (if STATE bit) |

**entity flags bitfield**
```
bit 0  POS present
bit 1  VEL present
bit 2  YAW present
bit 3  HP present
bit 4  STATE present
bit 5  IS_SELF      (this is the receiving client's own player)
bit 6  SPAWNED      (entity entered view this tick)
bit 7  DESPAWNED    (entity left view / destroyed)
bit 8-15 reserved
```

---

## Event  (server → client) — reliable channel

Discrete, must-not-drop game events. On WebTransport these go on a reliable
stream; on WebSocket they share the single ordered connection.

| Field | Type | Notes |
|---|---|---|
| `type` | u8 | `0x03` |
| `eventType` | u8 | `1=HIT 2=KILL 3=SPAWN 4=ROUND_START 5=ROUND_END 6=SOUND` |
| `tick` | u32 | server tick the event occurred |
| `payload` | … | event-specific (e.g. KILL: attackerId u16, victimId u16, weapon u8) |

---

## Quantization notes
- Positions: pick a world-bound (e.g. ±512 m) and map to i16 → ~1.5 cm
  resolution. Document the scale constant in `shared`.
- Angles: u16 over a full turn → ~0.0055° resolution, plenty for aim.
- Keep the quantization constants in `packages/shared` so client and server agree.
