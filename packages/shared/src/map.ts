// Sandline vertical model — ported VERBATIM from the game's map/Sandline.ts so the
// authoritative server samples the exact same ground the client predicts on.
//
// The map has a single sloped ground surface (no explicit decks today): groundH(z)
// is +6 at the attacker back-alley (north) and walks DOWNHILL to 0 at the sites /
// defender spawn (south). The FloorField (explicit floors/ramps/ceilings) is empty
// in the current map but kept so a future multi-deck map "just works" once re-baked.
//
// Horizontal collision is AABBs (MAP_COLLIDERS in map-data.ts), resolved in
// movement.ts. This module owns only the Y/floor sampling.

export type FloorRect = { minX: number; maxX: number; minZ: number; maxZ: number; y: number };
export type Ramp = {
  minX: number; maxX: number; minZ: number; maxZ: number;
  axis: "x" | "z"; lo: number; hi: number; yLo: number; yHi: number;
};
export type FloorField = { floors: FloorRect[]; ramps: Ramp[]; ceilings: FloorRect[] };

// World scale: the map is authored at 1x and scaled S× in x/z (heights unchanged).
// Runtime sampling gets WORLD coords, so groundH() divides z back to raw.
export const MAP_SCALE = 2;

function groundHRaw(z: number): number {
  if (z <= -38) return 6;
  if (z < -10) return 1 + ((z + 10) / -28) * 5;
  if (z < 2) return (2 - z) / 12;
  return 0;
}

/** Design ground height (metres) at WORLD z. */
export function groundH(z: number): number {
  return groundHRaw(z / MAP_SCALE);
}

/** Highest walkable surface at (x,z) within `stepUp` of the feet — sloped ground
 *  plus any explicit lower-deck floors / ramps. */
export function sampleFloor(field: FloorField, x: number, z: number, feetY: number, stepUp = 0.7): number {
  let best = -Infinity;
  const cap = feetY + stepUp;
  const g = groundH(z);
  if (g <= cap && g > best) best = g;
  for (const f of field.floors) {
    if (x >= f.minX && x <= f.maxX && z >= f.minZ && z <= f.maxZ && f.y <= cap && f.y > best) best = f.y;
  }
  for (const r of field.ramps) {
    if (x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ) {
      const c = r.axis === "x" ? x : z;
      const t = Math.max(0, Math.min(1, (c - r.lo) / (r.hi - r.lo)));
      const y = r.yLo + t * (r.yHi - r.yLo);
      if (y <= cap && y > best) best = y;
    }
  }
  return best;
}

/** Lowest ceiling strictly above the feet at (x,z), or +Infinity if none. */
export function sampleCeiling(field: FloorField, x: number, z: number, feetY: number): number {
  let best = Infinity;
  for (const c of field.ceilings) {
    if (x >= c.minX && x <= c.maxX && z >= c.minZ && z <= c.maxZ && c.y > feetY + 0.1 && c.y < best) best = c.y;
  }
  return best;
}
