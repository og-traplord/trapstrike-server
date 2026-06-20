import { describe, expect, it } from "vitest";
import type { PlayerInput } from "@trapstrike/shared";
import {
  Button,
  EntFlag,
  EntityState,
  EventType,
  type GameEvent,
  type Snapshot,
  decodeEvent,
  decodeInputCmd,
  decodeSnapshot,
  encodeEvent,
  encodeInputCmd,
  encodeSnapshot,
} from "../src/index";

const near = (a: number, b: number, eps: number) =>
  expect(Math.abs(a - b)).toBeLessThanOrEqual(eps);

describe("InputCmd round-trip", () => {
  it("preserves all fields within quantization tolerance", () => {
    const cmd: PlayerInput = {
      seq: 4321,
      dtMs: 16,
      moveX: -0.5,
      moveZ: 1,
      yaw: 1.2345,
      pitch: -0.4,
      buttons: Button.JUMP | Button.ADS,
    };
    const dec = decodeInputCmd(encodeInputCmd(cmd));
    expect(dec.seq).toBe(4321);
    expect(dec.dtMs).toBe(16);
    expect(dec.buttons).toBe(Button.JUMP | Button.ADS);
    near(dec.moveX, -0.5, 0.01);
    near(dec.moveZ, 1, 0.01);
    near(dec.yaw, 1.2345, 0.001);
    near(dec.pitch, -0.4, 0.001);
    expect(dec.fireTick).toBeUndefined();
  });

  it("is ~10 bytes without fire, +4 with fire and carries fireTick", () => {
    const base: PlayerInput = {
      seq: 1,
      dtMs: 33,
      moveX: 0,
      moveZ: 0,
      yaw: 0,
      pitch: 0,
      buttons: 0,
    };
    expect(encodeInputCmd(base).byteLength).toBe(11);

    const firing: PlayerInput = { ...base, buttons: Button.FIRE, fireTick: 987654 };
    const enc = encodeInputCmd(firing);
    expect(enc.byteLength).toBe(15);
    expect(decodeInputCmd(enc).fireTick).toBe(987654);
  });

  it("clamps dtMs into 1..255", () => {
    const enc = encodeInputCmd({
      seq: 0,
      dtMs: 9000,
      moveX: 0,
      moveZ: 0,
      yaw: 0,
      pitch: 0,
      buttons: 0,
    });
    expect(decodeInputCmd(enc).dtMs).toBe(255);
  });
});

describe("Snapshot round-trip", () => {
  it("encodes only flagged fields and decodes them back", () => {
    const snap: Snapshot = {
      tick: 123456,
      ackSeq: 42,
      entities: [
        {
          id: 1,
          flags: EntFlag.POS | EntFlag.YAW | EntFlag.HP | EntFlag.STATE | EntFlag.IS_SELF,
          pos: { x: 12.5, y: 0, z: -33.2 },
          yaw: 2.5,
          hp: 87,
          state: EntityState.ALIVE,
        },
        {
          id: 2,
          flags: EntFlag.POS | EntFlag.VEL,
          pos: { x: -100.1, y: 0, z: 5 },
          vel: { x: 6, y: 0, z: 0 },
        },
      ],
    };
    const dec = decodeSnapshot(encodeSnapshot(snap));
    expect(dec.tick).toBe(123456);
    expect(dec.ackSeq).toBe(42);
    expect(dec.entities).toHaveLength(2);

    const a = dec.entities[0]!;
    expect(a.id).toBe(1);
    expect(a.flags & EntFlag.IS_SELF).toBeTruthy();
    near(a.pos!.x, 12.5, 0.02);
    near(a.pos!.z, -33.2, 0.02);
    near(a.yaw!, 2.5, 0.001);
    expect(a.hp).toBe(87);
    expect(a.state).toBe(EntityState.ALIVE);
    expect(a.vel).toBeUndefined(); // VEL flag not set → field absent

    const b = dec.entities[1]!;
    near(b.pos!.x, -100.1, 0.02);
    near(b.vel!.x, 6, 0.01);
    expect(b.yaw).toBeUndefined();
    expect(b.hp).toBeUndefined();
  });

  it("handles an empty entity list", () => {
    const dec = decodeSnapshot(encodeSnapshot({ tick: 7, ackSeq: 0, entities: [] }));
    expect(dec.tick).toBe(7);
    expect(dec.entities).toHaveLength(0);
  });
});

describe("Event round-trip", () => {
  it("preserves a KILL event", () => {
    const ev: GameEvent = {
      eventType: EventType.KILL,
      tick: 9001,
      attackerId: 3,
      victimId: 7,
      weapon: 0,
      damage: 34,
      hpRemaining: 0,
    };
    const dec = decodeEvent(encodeEvent(ev));
    expect(dec).toEqual(ev);
  });

  it("preserves a HIT event", () => {
    const ev: GameEvent = {
      eventType: EventType.HIT,
      tick: 42,
      attackerId: 1,
      victimId: 2,
      weapon: 0,
      damage: 34,
      hpRemaining: 66,
    };
    expect(decodeEvent(encodeEvent(ev))).toEqual(ev);
  });
});
