// Shared, authoritative constants. Imported by server AND (later) the browser
// client so prediction and authority agree bit-for-bit. PROTOCOL.md requires the
// quantization constants to live here.

export const PROTOCOL_VERSION = 1;

// --- Simulation cadence (Law 2: fixed-step @ 30 Hz) ---
export const TICK_HZ = 30;
export const TICK_DT_MS = 1000 / TICK_HZ; // 33.333...
export const TICK_DT_S = 1 / TICK_HZ; // 0.033333... seconds — the ONLY dt the sim uses

// --- Snapshot cadence (Law 3: 20 Hz) ---
export const SNAPSHOT_HZ = 20;
export const SNAPSHOT_DT_MS = 1000 / SNAPSHOT_HZ; // 50 — note: not an integer # of ticks,
// so snapshots are scheduled off a time accumulator, not `tick % N`.

// Input button bits — MIRROR of protocol/constants.ts `Button` (kept here so the
// shared sim reads movement intent without depending on the protocol package). If
// you change one, change the other.
export const BTN_FIRE = 1 << 0;
export const BTN_JUMP = 1 << 1;
export const BTN_CROUCH = 1 << 2;
export const BTN_WALK = 1 << 6; // Shift = slow/quiet walk

// --- Movement (ported 1:1 from the game's Player.ts so prediction == authority) ---
export const WALK_SPEED = 6.5; // default "run"
export const SLOW_WALK_SPEED = 3.3; // Button.WALK (Shift) = quiet walk
export const CROUCH_SPEED = 2.6; // Button.CROUCH (Ctrl)
export const JUMP_VELOCITY = 7.0;
export const GRAVITY = 24.0;

export const PLAYER_RADIUS = 0.4; // movement capsule radius (collision)
export const PLAYER_HEIGHT = 1.8; // feet → head
export const STEP_UP = 0.7; // how far up sampleFloor will snap (walk ramps/ledges)

// Map clamp — the perimeter backstop (WORLD coords; the scaled map spans ~±100).
export const MAP_CLAMP_X = 99;
export const MAP_CLAMP_Z_MIN = -94;
export const MAP_CLAMP_Z_MAX = 98;
export const KILL_PLANE_Y = -10; // feet below this snap back up (can't fall out)

export const GROUND_Y = 0; // legacy flat reference (spawns/respawn fall to real floor)

// --- Quantization (PROTOCOL.md §"Quantization notes") ---
const I16_MAX = 32767;

// Positions: ±512 m mapped to i16 → ~1.56 cm resolution.
export const WORLD_BOUND_M = 512;
export const POS_SCALE = I16_MAX / WORLD_BOUND_M; // ~63.99 units per metre

// Velocity: ±64 m/s mapped to i16.
export const VEL_BOUND_MPS = 64;
export const VEL_SCALE = I16_MAX / VEL_BOUND_MPS;

// Angles: full turn over u16 → ~0.0055° resolution.
export const TAU = Math.PI * 2;
export const YAW_SCALE = 65536 / TAU;

// Pitch: ±90° over i16.
export const PITCH_LIMIT = Math.PI / 2;
export const PITCH_SCALE = I16_MAX / PITCH_LIMIT;

// Move axes: i8 (-127..127) ↔ -1..1.
export const MOVE_AXIS_MAX = 127;

// --- Combat / hitscan (M4) ---
export const EYE_HEIGHT = 1.6; // ray origin = feet + eye height
export const HITBOX_RADIUS = 0.45; // capsule radius
export const HITBOX_FOOT = 0.1; // capsule core: feet + foot …
export const HITBOX_HEAD = 1.8; //               … to feet + head

export const WEAPON_DAMAGE = 34; // 3 shots to down 100 hp
export const WEAPON_RANGE_M = 100;
export const WEAPON_COOLDOWN_TICKS = 6; // ≈5 shots/s at 30 Hz — fire-rate gate
export const WEAPON_MAG_SIZE = 30;

export const MAX_HP = 100;
export const RESPAWN_TICKS = 60; // 2 s

// Lag compensation: how far back the server rewinds hitboxes (~1 s).
export const LAGCOMP_MAX_TICKS = 30;
export const HISTORY_SIZE = 40; // ring buffer depth (> LAGCOMP_MAX_TICKS)

/**
 * Real static world geometry, baked from the game's Sandline map (92 AABBs). These
 * now serve DOUBLE duty: horizontal movement collision (movement.ts) AND shot
 * line-of-sight (combat). Re-bake with `cd game && npx tsx scripts/bake-colliders.ts`.
 */
export { MAP_COLLIDERS, MAP_FLOOR_FIELD, SPAWN_ATTACK_FEET, SPAWN_DEFEND_FEET, ENEMY_POINTS, PLANT_A, PLANT_B } from "./map-data";

/** @deprecated kept as an alias so older imports resolve; use MAP_COLLIDERS. */
export { MAP_COLLIDERS as ARENA_WALLS } from "./map-data";
