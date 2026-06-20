import {
  BTN_CROUCH,
  BTN_JUMP,
  BTN_WALK,
  CROUCH_SPEED,
  GRAVITY,
  JUMP_VELOCITY,
  KILL_PLANE_Y,
  MAP_CLAMP_X,
  MAP_CLAMP_Z_MAX,
  MAP_CLAMP_Z_MIN,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  SLOW_WALK_SPEED,
  STEP_UP,
  WALK_SPEED,
} from "./constants";
import { type FloorField, sampleCeiling, sampleFloor } from "./map";
import { MAP_COLLIDERS, MAP_FLOOR_FIELD } from "./map-data";
import type { AABB, PlayerInput, PlayerState } from "./types";

/**
 * Deterministic authoritative movement step — ported VERBATIM from the game's
 * `Player.update` so the predicting client and the server produce bit-identical
 * paths for the same inputs. Mutates `state` in place (no allocation).
 *
 * `state.pos` is FEET. `dt` is seconds, supplied by the caller (the server's fixed
 * tick dt; the client replays inputs with the SAME dt). `input.dtMs` is deliberately
 * NOT used for distance — trusting client frame time would be a speed cheat.
 *
 * Move convention matches the game exactly: `moveX` is strafe (A = -1, D = +1),
 * `moveZ` is forward/back (W = -1, S = +1); forward in world space is (-sinYaw,
 * -cosYaw). Horizontal collision is axis-by-axis AABB resolve against `colliders`;
 * the vertical model is gravity + `sampleFloor` (walk up ramps/slope, fall off
 * ledges), a ceiling bonk, and a kill-plane backstop.
 */
export function stepPlayer(
  state: PlayerState,
  input: PlayerInput,
  dt: number,
  colliders: AABB[] = MAP_COLLIDERS,
  field: FloorField = MAP_FLOOR_FIELD,
): void {
  // --- horizontal wish direction (game convention) ---
  let mvx = input.moveX;
  let mvz = input.moveZ;
  const len = Math.hypot(mvx, mvz);
  if (len > 0) {
    mvx /= len;
    mvz /= len; // game normalizes to unit whenever there's input (diagonal == cardinal speed)
  }

  let speed = WALK_SPEED;
  if (input.buttons & BTN_WALK) speed = SLOW_WALK_SPEED; // Shift = quiet walk
  if (input.buttons & BTN_CROUCH) speed = CROUCH_SPEED; // crouch overrides (checked last)

  const cosY = Math.cos(input.yaw);
  const sinY = Math.sin(input.yaw);
  const wx = mvx * cosY + mvz * sinY;
  const wz = -mvx * sinY + mvz * cosY;
  state.vel.x = wx * speed;
  state.vel.z = wz * speed;

  // --- integrate horizontal, resolving wall collisions one axis at a time ---
  state.pos.x += state.vel.x * dt;
  resolveAxis(state, "x", colliders);
  state.pos.z += state.vel.z * dt;
  resolveAxis(state, "z", colliders);

  // perimeter clamp (backstop just inside the outer walls)
  if (state.pos.x < -MAP_CLAMP_X) state.pos.x = -MAP_CLAMP_X;
  else if (state.pos.x > MAP_CLAMP_X) state.pos.x = MAP_CLAMP_X;
  if (state.pos.z < MAP_CLAMP_Z_MIN) state.pos.z = MAP_CLAMP_Z_MIN;
  else if (state.pos.z > MAP_CLAMP_Z_MAX) state.pos.z = MAP_CLAMP_Z_MAX;

  // --- vertical: gravity + floor sampling + jump + ceiling + kill-plane ---
  state.vel.y -= GRAVITY * dt;
  if (input.buttons & BTN_JUMP && state.onGround) {
    state.vel.y = JUMP_VELOCITY;
    state.onGround = false;
  }
  const feetY = state.pos.y; // pos = feet
  const groundY = sampleFloor(field, state.pos.x, state.pos.z, feetY, STEP_UP);
  let newFeet = feetY + state.vel.y * dt;
  if (newFeet <= groundY) {
    newFeet = groundY;
    state.vel.y = 0;
    state.onGround = true;
  } else {
    state.onGround = false;
  }
  const ceilY = sampleCeiling(field, state.pos.x, state.pos.z, newFeet);
  if (newFeet + PLAYER_HEIGHT > ceilY) {
    newFeet = ceilY - PLAYER_HEIGHT;
    if (state.vel.y > 0) state.vel.y = 0;
  }
  // Kill-plane backstop: if we somehow drop below the world, snap up to the surface.
  if (newFeet < KILL_PLANE_Y) {
    const surface = sampleFloor(field, state.pos.x, state.pos.z, 1000, STEP_UP);
    newFeet = (isFinite(surface) ? surface : 0) + 0.1;
    state.vel.y = 0;
    state.onGround = true;
  }
  state.pos.y = newFeet;

  state.yaw = input.yaw;
  state.pitch = input.pitch;
}

/** Push the player's AABB out of any overlapping collider along ONE axis (the game's
 *  resolveAxis, with pos = feet so the y-span is feet..feet+height). */
function resolveAxis(state: PlayerState, axis: "x" | "z", colliders: AABB[]): void {
  const r = PLAYER_RADIUS;
  let minX = state.pos.x - r;
  let maxX = state.pos.x + r;
  const minY = state.pos.y;
  const maxY = state.pos.y + PLAYER_HEIGHT;
  let minZ = state.pos.z - r;
  let maxZ = state.pos.z + r;

  for (const c of colliders) {
    if (
      minX < c.max.x &&
      maxX > c.min.x &&
      minY < c.max.y &&
      maxY > c.min.y &&
      minZ < c.max.z &&
      maxZ > c.min.z
    ) {
      if (axis === "x") {
        if (state.vel.x > 0) state.pos.x = c.min.x - r - 0.001;
        else if (state.vel.x < 0) state.pos.x = c.max.x + r + 0.001;
        state.vel.x = 0;
        minX = state.pos.x - r;
        maxX = state.pos.x + r;
      } else {
        if (state.vel.z > 0) state.pos.z = c.min.z - r - 0.001;
        else if (state.vel.z < 0) state.pos.z = c.max.z + r + 0.001;
        state.vel.z = 0;
        minZ = state.pos.z - r;
        maxZ = state.pos.z + r;
      }
    }
  }
}
