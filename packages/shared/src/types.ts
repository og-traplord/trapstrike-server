export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Axis-aligned bounding box (static world geometry / LOS blockers). */
export interface AABB {
  min: Vec3;
  max: Vec3;
}

/** Decoded player intent. Semantic units (metres, radians, -1..1). */
export interface PlayerInput {
  seq: number; // u16, monotonically increasing (wraps)
  dtMs: number; // client frame delta — carried per protocol, NOT used for sim distance
  moveX: number; // strafe, -1..1
  moveZ: number; // forward, -1..1
  yaw: number; // radians
  pitch: number; // radians
  buttons: number; // bitfield
  fireTick?: number; // client tick at trigger (lag comp, M4)
}

/** Authoritative per-player world state. `pos` = FEET (eye/hitbox add offsets).
 *  Mutated in place — never re-allocated in the hot loop. */
export interface PlayerState {
  pos: Vec3;
  vel: Vec3;
  yaw: number;
  pitch: number;
  onGround: boolean;
}

export function makePlayerState(x = 0, y = 0, z = 0): PlayerState {
  return { pos: { x, y, z }, vel: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, onGround: false };
}

export function emptyInput(seq = 0): PlayerInput {
  return { seq, dtMs: 33, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0 };
}
