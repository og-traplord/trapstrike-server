import {
  type AABB,
  HITBOX_FOOT,
  HITBOX_HEAD,
  HITBOX_RADIUS,
  type Vec3,
  WEAPON_RANGE_M,
  rayAabb,
  rayCapsule,
} from "@trapstrike/shared";

/** A candidate target, already rewound to the shooter's fireTick. `feet` = world position. */
export interface ShotTarget {
  id: number;
  feet: Vec3;
}

export interface ShotResult {
  hitId: number | null;
  hitDist: number;
  blockedByWall: boolean;
}

/**
 * Pure server-side hitscan resolution. Given a ray (eye origin + aim dir) and the
 * set of rewound targets + static walls, returns the nearest target hit — unless a
 * wall is closer (line-of-sight blocked). The client supplies only origin (its own
 * authoritative position), aim, and fireTick; the hit decision is entirely here.
 */
export function resolveShot(
  origin: Vec3,
  dir: Vec3,
  targets: ShotTarget[],
  walls: AABB[],
  rangeM: number = WEAPON_RANGE_M,
): ShotResult {
  // Nearest wall along the ray (line-of-sight blocker).
  let wallT = Number.POSITIVE_INFINITY;
  for (const w of walls) {
    const t = rayAabb(origin, dir, w.min, w.max);
    if (t !== null && t >= 0 && t < wallT) wallT = t;
  }

  // Nearest target capsule along the ray.
  let bestId: number | null = null;
  let bestT = Number.POSITIVE_INFINITY;
  for (const tg of targets) {
    const a: Vec3 = { x: tg.feet.x, y: tg.feet.y + HITBOX_FOOT, z: tg.feet.z };
    const b: Vec3 = { x: tg.feet.x, y: tg.feet.y + HITBOX_HEAD, z: tg.feet.z };
    const t = rayCapsule(origin, dir, a, b, HITBOX_RADIUS, rangeM);
    if (t !== null && t < bestT) {
      bestT = t;
      bestId = tg.id;
    }
  }

  if (bestId === null || bestT > rangeM) {
    return { hitId: null, hitDist: bestT, blockedByWall: false };
  }
  if (wallT < bestT) {
    return { hitId: null, hitDist: wallT, blockedByWall: true };
  }
  return { hitId: bestId, hitDist: bestT, blockedByWall: false };
}
