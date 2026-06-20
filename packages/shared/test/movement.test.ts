import { describe, expect, it } from "vitest";
import {
  type AABB,
  BTN_JUMP,
  MAP_CLAMP_X,
  TICK_DT_S,
  WALK_SPEED,
  emptyInput,
  groundH,
  makePlayerState,
  stepPlayer,
  type PlayerInput,
  type PlayerState,
} from "../src/index";

const clone = (s: PlayerState): PlayerState => ({
  pos: { ...s.pos },
  vel: { ...s.vel },
  yaw: s.yaw,
  pitch: s.pitch,
  onGround: s.onGround,
});

const input = (over: Partial<PlayerInput>): PlayerInput => ({ ...emptyInput(), ...over });
const NO_WALLS: AABB[] = []; // run pure movement math without the map's colliders

describe("stepPlayer (deterministic sim — ported from the game)", () => {
  it("is deterministic: same start + same inputs → identical state", () => {
    const a = makePlayerState(0, 0, 10);
    const b = makePlayerState(0, 0, 10);
    const cmds = [
      input({ moveZ: 1, yaw: 0.3 }),
      input({ moveX: 1, yaw: 1.1 }),
      input({ moveX: -1, moveZ: 1, yaw: 2.0, buttons: BTN_JUMP }),
    ];
    for (const c of cmds) stepPlayer(a, c, TICK_DT_S);
    for (const c of cmds) stepPlayer(b, c, TICK_DT_S);
    expect(clone(a)).toEqual(clone(b));
  });

  it("moveZ=1 at yaw 0 moves +Z (game convention)", () => {
    const s = makePlayerState(0, 0, 10); // z≥4 → groundH 0 (flat), keeps Y predictable
    const steps = 20;
    for (let i = 0; i < steps; i++) stepPlayer(s, input({ moveZ: 1, yaw: 0 }), TICK_DT_S, NO_WALLS);
    expect(s.pos.z).toBeCloseTo(10 + WALK_SPEED * TICK_DT_S * steps, 4);
    expect(s.pos.x).toBeCloseTo(0, 6);
    expect(s.onGround).toBe(true);
    expect(s.pos.y).toBeCloseTo(groundH(s.pos.z), 5); // feet rest on the floor
  });

  it("rotates wish-direction by yaw (moveZ at yaw π/2 → +X)", () => {
    const s = makePlayerState(0, 0, 10);
    for (let i = 0; i < 10; i++) stepPlayer(s, input({ moveZ: 1, yaw: Math.PI / 2 }), TICK_DT_S, NO_WALLS);
    expect(s.pos.x).toBeGreaterThan(0.1);
    expect(Math.abs(s.pos.z - 10)).toBeLessThan(1e-6);
  });

  it("normalizes diagonal input to walk speed (no sqrt(2) boost)", () => {
    const s = makePlayerState(0, 0, 10);
    stepPlayer(s, input({ moveX: 1, moveZ: 1, yaw: 0 }), TICK_DT_S, NO_WALLS);
    expect(Math.hypot(s.vel.x, s.vel.z)).toBeCloseTo(WALK_SPEED, 5);
  });

  it("stays put horizontally with no input", () => {
    const s = makePlayerState(3, 0, 10);
    stepPlayer(s, input({}), TICK_DT_S, NO_WALLS);
    expect(s.pos.x).toBe(3);
    expect(s.pos.z).toBe(10);
    expect(s.vel.x).toBe(0);
    expect(s.vel.z).toBe(0);
  });

  it("jumps then gravity returns to the floor", () => {
    const s = makePlayerState(0, 0, 10);
    stepPlayer(s, input({}), TICK_DT_S, NO_WALLS); // settle on ground
    expect(s.onGround).toBe(true);
    stepPlayer(s, input({ buttons: BTN_JUMP }), TICK_DT_S, NO_WALLS); // leap
    expect(s.vel.y).toBeGreaterThan(0);
    expect(s.onGround).toBe(false);
    const apex = s.pos.y;
    expect(apex).toBeGreaterThan(0.1);
    for (let i = 0; i < 60; i++) stepPlayer(s, input({}), TICK_DT_S, NO_WALLS); // fall back
    expect(s.onGround).toBe(true);
    expect(s.pos.y).toBeCloseTo(groundH(s.pos.z), 5);
  });

  it("walks UP the slope: heading north (−Z) raises feet toward the back-alley", () => {
    const s = makePlayerState(0, 0, 10); // flat ground (groundH 0)
    // moveZ=-1 at yaw 0 drives −Z (north, toward the raised attacker spawn). The
    // floor only rises north of world z≈4, so walk a long way to climb.
    for (let i = 0; i < 300; i++) stepPlayer(s, input({ moveZ: -1, yaw: 0 }), TICK_DT_S, NO_WALLS);
    expect(s.pos.z).toBeLessThan(0); // moved north
    expect(s.pos.y).toBeGreaterThan(0.5); // climbed the slope
    expect(s.pos.y).toBeCloseTo(groundH(s.pos.z), 4);
  });

  it("clamps to the map perimeter", () => {
    const s = makePlayerState(MAP_CLAMP_X - 0.02, 0, 10);
    for (let i = 0; i < 200; i++) stepPlayer(s, input({ moveZ: 1, yaw: Math.PI / 2 }), TICK_DT_S, NO_WALLS);
    expect(s.pos.x).toBe(MAP_CLAMP_X);
  });

  it("collides with the real map: a wall stops forward motion short of it", () => {
    // The west outer wall sits at x≈−100. Walk hard −X into it from open ground.
    const s = makePlayerState(-90, 0, 10);
    for (let i = 0; i < 200; i++) stepPlayer(s, input({ moveZ: 1, yaw: -Math.PI / 2 }), TICK_DT_S);
    expect(s.pos.x).toBeGreaterThan(-99.5); // stopped at the wall, not through it
    expect(s.pos.x).toBeLessThan(-95);
  });
});
