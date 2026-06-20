import { describe, expect, it } from "vitest";
import { aimDirection, rayAabb, rayCapsule } from "../src/index";

describe("aimDirection (game camera convention: forward = (-sinY·cosP, sinP, -cosY·cosP))", () => {
  it("yaw=0,pitch=0 points −Z (camera looks down local −Z)", () => {
    const d = aimDirection(0, 0);
    expect(d.z).toBeCloseTo(-1, 6);
    expect(d.x).toBeCloseTo(0, 6);
    expect(d.y).toBeCloseTo(0, 6);
  });
  it("yaw=π/2,pitch=0 points −X", () => {
    const d = aimDirection(Math.PI / 2, 0);
    expect(d.x).toBeCloseTo(-1, 6);
    expect(d.z).toBeCloseTo(0, 6);
  });
  it("positive pitch aims up (+Y)", () => {
    const d = aimDirection(0, 0.5);
    expect(d.y).toBeCloseTo(Math.sin(0.5), 6);
  });
});

describe("rayAabb", () => {
  const min = { x: 2, y: -1, z: -1 };
  const max = { x: 3, y: 1, z: 1 };
  it("hits a box straight ahead at entry distance", () => {
    const t = rayAabb({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, min, max);
    expect(t).not.toBeNull();
    expect(t!).toBeCloseTo(2, 5);
  });
  it("misses when pointing away", () => {
    expect(rayAabb({ x: 0, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, min, max)).toBeNull();
  });
  it("misses when parallel and outside the slab", () => {
    expect(rayAabb({ x: 0, y: 5, z: 0 }, { x: 1, y: 0, z: 0 }, min, max)).toBeNull();
  });
});

describe("rayCapsule (vertical capsule)", () => {
  const A = { x: 5, y: -1, z: 0 };
  const B = { x: 5, y: 1, z: 0 };
  const r = 0.5;
  it("hits a capsule on the ray's path", () => {
    const t = rayCapsule({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, A, B, r, 100);
    expect(t).not.toBeNull();
    expect(t!).toBeCloseTo(5, 1);
  });
  it("hits when within the radius", () => {
    const t = rayCapsule({ x: 0, y: 0, z: 0.3 }, { x: 1, y: 0, z: 0 }, A, B, r, 100);
    expect(t).not.toBeNull();
  });
  it("misses when offset beyond the radius", () => {
    const t = rayCapsule({ x: 0, y: 0, z: 1.5 }, { x: 1, y: 0, z: 0 }, A, B, r, 100);
    expect(t).toBeNull();
  });
  it("misses when the target is beyond maxT (out of range)", () => {
    const t = rayCapsule({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, A, B, r, 3);
    expect(t).toBeNull();
  });
});
