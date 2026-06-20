// Deterministic ray geometry for server-side hitscan (M4). Pure + unit-tested, in
// shared so the client could later reuse it (tracers / client-side hit prediction).

import type { AABB, Vec3 } from "./types";

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const mul = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Aim direction (unit) from yaw/pitch. Matches the game camera's forward vector
 *  (THREE Euler order "YXZ", looking down local -Z): forward =
 *  (-sinYaw·cosPitch, sinPitch, -cosYaw·cosPitch). Same convention as movement. */
export function aimDirection(yaw: number, pitch: number): Vec3 {
  const cp = Math.cos(pitch);
  return { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
}

/** Ray vs axis-aligned box (slab method). Returns entry distance t≥0, or null. */
export function rayAabb(o: Vec3, d: Vec3, min: Vec3, max: Vec3): number | null {
  let tmin = 0;
  let tmax = Number.POSITIVE_INFINITY;
  const EPS = 1e-9;

  // x
  if (Math.abs(d.x) < EPS) {
    if (o.x < min.x || o.x > max.x) return null;
  } else {
    const inv = 1 / d.x;
    let t1 = (min.x - o.x) * inv;
    let t2 = (max.x - o.x) * inv;
    if (t1 > t2) [t1, t2] = [t2, t1];
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  // y
  if (Math.abs(d.y) < EPS) {
    if (o.y < min.y || o.y > max.y) return null;
  } else {
    const inv = 1 / d.y;
    let t1 = (min.y - o.y) * inv;
    let t2 = (max.y - o.y) * inv;
    if (t1 > t2) [t1, t2] = [t2, t1];
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  // z
  if (Math.abs(d.z) < EPS) {
    if (o.z < min.z || o.z > max.z) return null;
  } else {
    const inv = 1 / d.z;
    let t1 = (min.z - o.z) * inv;
    let t2 = (max.z - o.z) * inv;
    if (t1 > t2) [t1, t2] = [t2, t1];
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  return tmin;
}

/**
 * Ray vs capsule (segment A→B, radius r), where the ray is O + D·t for t∈[0,maxT]
 * and D is unit. Returns the ray distance t at closest approach if it's within the
 * capsule radius (a hit), else null. Uses the closest distance between the ray
 * (as a segment of length maxT) and the capsule's core segment.
 */
export function rayCapsule(
  O: Vec3,
  D: Vec3,
  A: Vec3,
  B: Vec3,
  r: number,
  maxT: number,
): number | null {
  const EPS = 1e-8;
  const p1 = O;
  const q1 = add(O, mul(D, maxT));
  const d1 = sub(q1, p1);
  const d2 = sub(B, A);
  const r0 = sub(p1, A);
  const a = dot(d1, d1);
  const e = dot(d2, d2);
  const f = dot(d2, r0);

  let s: number;
  let t: number;
  if (a <= EPS && e <= EPS) {
    s = 0;
    t = 0;
  } else if (a <= EPS) {
    s = 0;
    t = clamp01(f / e);
  } else {
    const c = dot(d1, r0);
    if (e <= EPS) {
      t = 0;
      s = clamp01(-c / a);
    } else {
      const b = dot(d1, d2);
      const denom = a * e - b * b;
      s = denom > EPS ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp01(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp01((b - c) / a);
      }
    }
  }

  const c1 = add(p1, mul(d1, s));
  const c2 = add(A, mul(d2, t));
  const diff = sub(c1, c2);
  if (dot(diff, diff) <= r * r) {
    const rayT = s * maxT;
    if (rayT >= 0 && rayT <= maxT) return rayT;
  }
  return null;
}

export type { AABB };
