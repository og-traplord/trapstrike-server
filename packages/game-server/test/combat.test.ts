import { describe, expect, it } from "vitest";
import {
  type AABB,
  EYE_HEIGHT,
  HITBOX_FOOT,
  HITBOX_HEAD,
  TICK_DT_S,
  WEAPON_DAMAGE,
  aimDirection,
  type PlayerInput,
  type Vec3,
} from "@trapstrike/shared";
import { Button, EventType, type GameEvent, decodeEvent } from "@trapstrike/protocol";
import { type ShotTarget, resolveShot } from "../src/combat";
import { Match } from "../src/match";
import type { TransportConnection } from "../src/transport/types";

// --- helpers ---
const CHEST = (HITBOX_FOOT + HITBOX_HEAD) / 2;

function aimFromTo(eye: Vec3, targetFeet: Vec3): { yaw: number; pitch: number } {
  const dx = targetFeet.x - eye.x;
  const dz = targetFeet.z - eye.z;
  const dy = targetFeet.y + CHEST - eye.y;
  // Game camera convention: forward = (-sinYaw·cosPitch, sinPitch, -cosYaw·cosPitch),
  // so to look along (dx,dz) we need yaw = atan2(-dx, -dz).
  return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
}

// ===================== pure resolveShot =====================

describe("resolveShot (pure)", () => {
  const origin: Vec3 = { x: 0, y: EYE_HEIGHT, z: 0 };

  it("registers a clean hit on a target in the open", () => {
    const feet: Vec3 = { x: 3, y: 0, z: 0 };
    const { yaw, pitch } = aimFromTo(origin, feet);
    const dir = aimDirection(yaw, pitch);
    const res = resolveShot(origin, dir, [{ id: 2, feet }], []);
    expect(res.hitId).toBe(2);
  });

  it("LAG COMP: a shot aimed where the target WAS hits only when rewound", () => {
    const wasAt: Vec3 = { x: 3, y: 0, z: 0 }; // position at fireTick (what the shooter saw)
    const nowAt: Vec3 = { x: 3, y: 0, z: 5 }; // moved away by the time the server processes it
    const { yaw, pitch } = aimFromTo(origin, wasAt);
    const dir = aimDirection(yaw, pitch);

    const rewound: ShotTarget[] = [{ id: 2, feet: wasAt }];
    const notRewound: ShotTarget[] = [{ id: 2, feet: nowAt }];

    expect(resolveShot(origin, dir, rewound, []).hitId).toBe(2); // with rewind → hit
    expect(resolveShot(origin, dir, notRewound, []).hitId).toBeNull(); // without → miss
  });

  it("blocks the shot when a wall is between shooter and target (LOS)", () => {
    const feet: Vec3 = { x: 5, y: 0, z: 0 };
    const { yaw, pitch } = aimFromTo(origin, feet);
    const dir = aimDirection(yaw, pitch);
    const wall: AABB = { min: { x: 2, y: 0, z: -1 }, max: { x: 3, y: 3, z: 1 } };

    expect(resolveShot(origin, dir, [{ id: 2, feet }], []).hitId).toBe(2); // clear
    const blocked = resolveShot(origin, dir, [{ id: 2, feet }], [wall]);
    expect(blocked.hitId).toBeNull();
    expect(blocked.blockedByWall).toBe(true);
  });
});

// ===================== Match-level (authority) =====================

class FakeConn implements TransportConnection {
  readonly kind = "ws" as const;
  readonly id: number;
  reliable: Uint8Array[] = [];
  unreliable: Uint8Array[] = [];
  constructor(id: number) {
    this.id = id;
  }
  sendUnreliable(d: Uint8Array): void {
    this.unreliable.push(d.slice());
  }
  sendReliable(d: Uint8Array): void {
    this.reliable.push(d.slice());
  }
  sendControl(): void {}
  onMessage(): void {}
  onClose(): void {}
  close(): void {}
}

const noop = (seq: number): PlayerInput => ({
  seq,
  dtMs: 33,
  moveX: 0,
  moveZ: 0,
  yaw: 0,
  pitch: 0,
  buttons: 0,
});
const fire = (seq: number, yaw: number, pitch: number, fireTick: number): PlayerInput => ({
  seq,
  dtMs: 33,
  moveX: 0,
  moveZ: 0,
  yaw,
  pitch,
  buttons: Button.FIRE,
  fireTick,
});

function eventsOf(conn: FakeConn): GameEvent[] {
  return conn.reliable.map((b) => decodeEvent(b));
}

describe("Match combat (server authority)", () => {
  function setup() {
    const m = new Match();
    const ca = new FakeConn(0);
    const cb = new FakeConn(0);
    const shooter = m.addPlayer(ca);
    const target = m.addPlayer(cb);
    // Real spawns are across the whole map (with walls between), so teleport both
    // into a known OPEN, flat spot (world z≥4 → groundH 0) for a clean line of sight.
    const shooterFeet: Vec3 = { x: 0, y: 0, z: 10 };
    const targetFeet: Vec3 = { x: 3, y: 0, z: 10 };
    m.setPlayerPose(shooter, shooterFeet);
    m.setPlayerPose(target, targetFeet);
    // Warm up history with both players stationary on the floor.
    let tick = 0;
    for (; tick < 10; tick++) {
      m.onInput(shooter, noop(tick + 1));
      m.onInput(target, noop(tick + 1));
      m.step(TICK_DT_S, tick);
    }
    const eye: Vec3 = { x: shooterFeet.x, y: shooterFeet.y + EYE_HEIGHT, z: shooterFeet.z };
    const aim = aimFromTo(eye, targetFeet);
    return { m, ca, cb, shooter, target, aim, tick };
  }

  it("a fire that hits emits a HIT with damage applied, server-side", () => {
    const { m, ca, shooter, target, aim } = setup();
    m.onInput(shooter, fire(100, aim.yaw, aim.pitch, 5));
    m.step(TICK_DT_S, 10);

    const hits = eventsOf(ca).filter((e) => e.eventType === EventType.HIT);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.attackerId).toBe(shooter);
    expect(hits[0]!.victimId).toBe(target);
    expect(hits[0]!.hpRemaining).toBe(100 - WEAPON_DAMAGE);
  });

  it("enforces the fire-rate cooldown (a second shot too soon is ignored)", () => {
    const { m, ca, shooter, aim } = setup();
    m.onInput(shooter, fire(100, aim.yaw, aim.pitch, 5));
    m.step(TICK_DT_S, 10); // fires
    m.onInput(shooter, fire(101, aim.yaw, aim.pitch, 6));
    m.step(TICK_DT_S, 11); // within cooldown → rejected

    const hits = eventsOf(ca).filter((e) => e.eventType === EventType.HIT);
    expect(hits).toHaveLength(1);
  });

  it("kills after enough hits and emits KILL", () => {
    const { m, ca, shooter, target, aim } = setup();
    let tick = 10;
    let seq = 100;
    // 3 shots × 34 dmg = 102 ≥ 100, spaced past the 6-tick cooldown.
    for (let shot = 0; shot < 3; shot++) {
      m.onInput(shooter, fire(seq++, aim.yaw, aim.pitch, tick - 2));
      m.step(TICK_DT_S, tick);
      tick += 7;
    }
    const evs = eventsOf(ca);
    expect(evs.filter((e) => e.eventType === EventType.HIT)).toHaveLength(3);
    const kills = evs.filter((e) => e.eventType === EventType.KILL);
    expect(kills).toHaveLength(1);
    expect(kills[0]!.attackerId).toBe(shooter);
    expect(kills[0]!.victimId).toBe(target);
  });

  it("a miss yields no event and no damage (client cannot force a hit)", () => {
    const { m, ca, shooter } = setup();
    // Aim −Z (yaw 0) while the target is at +X → miss.
    m.onInput(shooter, fire(100, 0, 0, 5));
    m.step(TICK_DT_S, 10);
    expect(eventsOf(ca).filter((e) => e.eventType === EventType.HIT)).toHaveLength(0);
  });
});
