import {
  EYE_HEIGHT,
  HISTORY_SIZE,
  LAGCOMP_MAX_TICKS,
  MAP_COLLIDERS,
  MAX_HP,
  PROTOCOL_VERSION,
  RESPAWN_TICKS,
  SNAPSHOT_HZ,
  TICK_HZ,
  type Vec3,
  WEAPON_COOLDOWN_TICKS,
  WEAPON_DAMAGE,
  WEAPON_MAG_SIZE,
  aimDirection,
  emptyInput,
  makePlayerState,
  type PlayerInput,
  type PlayerState,
  quantizePos,
  quantizeYaw,
  stepPlayer,
} from "@trapstrike/shared";
import {
  Button,
  ByteWriter,
  EntFlag,
  EntityState,
  EventType,
  type EntitySnap,
  type GameEvent,
  type Snapshot,
  encodeEvent,
  encodeSnapshot,
} from "@trapstrike/protocol";
import { type ShotTarget, resolveShot } from "./combat";
import { JitterBuffer } from "./jitter-buffer";
import type { TransportConnection } from "./transport/types";

interface SpawnPoint {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/** Casual "play with friends" spawns: everyone drops into the SAME spot near mid
 *  (open, flat lower-mid) in a tight cluster, so players see each other immediately
 *  instead of starting ~170 m apart at opposite team ends. Friendly fire is on, so
 *  it plays as a drop-in deathmatch. (A proper 5v5 round mode would restore the
 *  attacker/defender end spawns — see SPAWN_ATTACK_FEET / SPAWN_DEFEND_FEET.) */
function spawnFor(team: number, idxInTeam: number): SpawnPoint {
  const slot = (team * 5 + idxInTeam) % 10; // 0..9 across both teams
  const col = slot % 5; // 5 across
  const row = Math.floor(slot / 5); // 2 rows
  return {
    x: -6 + col * 3, // -6 … +6
    y: 0, // mid is flat (groundH ≈ 0); settles to the floor on the first step
    z: 8 + row * 4, // 8 or 12 — open lower-mid, clear of cover
    yaw: 0,
  };
}

interface SentEnt {
  x: number;
  y: number;
  z: number;
  yaw: number;
  hp: number;
  state: number;
}

interface HistEntry {
  tick: number;
  x: number;
  y: number;
  z: number;
}

interface FireIntent {
  shooterId: number;
  fireTick: number;
  yaw: number;
  pitch: number;
}

interface ServerPlayer {
  id: number;
  conn: TransportConnection;
  state: PlayerState;
  buffer: JitterBuffer;
  lastInput: PlayerInput;
  view: Map<number, SentEnt>;
  // combat
  team: number; // 0 or 1
  hp: number;
  alive: boolean;
  ammo: number;
  lastFireTick: number;
  respawnAtTick: number;
  spawn: SpawnPoint;
  // lag-comp position history (ring)
  history: HistEntry[];
  histHead: number;
}

/**
 * One match = one room = the authoritative world (Law 4). Simulates on a fixed
 * step, records a 1 s position history for lag compensation, resolves hitscan on
 * the server, and emits delta snapshots (unreliable) + combat events (reliable).
 */
export class Match {
  private players = new Map<number, ServerPlayer>();
  private nextEntityId = 1;
  private readonly snapWriter = new ByteWriter(2048);
  private readonly eventWriter = new ByteWriter(32);
  private respawnEnabled = true;
  private roundKills: [number, number] = [0, 0];

  get playerCount(): number {
    return this.players.size;
  }

  // --- Round lifecycle hooks (M6). The MatchLifecycle controller drives these;
  //     untouched in endless/deathmatch mode (M1–M5). ---

  setRespawnEnabled(on: boolean): void {
    this.respawnEnabled = on;
  }

  /** Revive everyone at their team spawn, reset hp/ammo, and reset the round score. */
  startRound(): void {
    this.roundKills = [0, 0];
    const idxByTeam = [0, 0];
    for (const p of this.players.values()) {
      const i = idxByTeam[p.team]++;
      p.spawn = spawnFor(p.team, i); // re-pack teammates tightly each round
      p.alive = true;
      p.hp = MAX_HP;
      p.ammo = WEAPON_MAG_SIZE;
      p.lastFireTick = -WEAPON_COOLDOWN_TICKS;
      this.placeAtSpawn(p);
    }
  }

  /** Snap a player to their spawn (feet, facing), zeroing velocity + ground state. */
  private placeAtSpawn(p: ServerPlayer): void {
    p.state.pos.x = p.spawn.x;
    p.state.pos.y = p.spawn.y;
    p.state.pos.z = p.spawn.z;
    p.state.vel.x = 0;
    p.state.vel.y = 0;
    p.state.vel.z = 0;
    p.state.yaw = p.spawn.yaw;
    p.state.onGround = true;
  }

  aliveByTeam(): [number, number] {
    const a: [number, number] = [0, 0];
    for (const p of this.players.values()) if (p.alive) a[p.team]++;
    return a;
  }

  get roundScore(): [number, number] {
    return this.roundKills;
  }

  /** Broadcast a lifecycle event (ROUND_START/ROUND_END) on the reliable channel. */
  broadcastEvent(ev: GameEvent): void {
    this.emitEvent(ev);
  }

  addPlayer(conn: TransportConnection): number {
    const id = this.nextEntityId++;
    const team = this.players.size % 2; // alternate → 5v5 for 10 players
    let idxInTeam = 0;
    for (const p of this.players.values()) if (p.team === team) idxInTeam++;
    const spawn = spawnFor(team, idxInTeam);
    const state = makePlayerState(spawn.x, spawn.y, spawn.z);
    state.yaw = spawn.yaw;
    const player: ServerPlayer = {
      id,
      conn,
      state,
      buffer: new JitterBuffer(),
      lastInput: emptyInput(),
      view: new Map(),
      team,
      hp: MAX_HP,
      alive: true,
      ammo: WEAPON_MAG_SIZE,
      lastFireTick: -WEAPON_COOLDOWN_TICKS,
      respawnAtTick: 0,
      spawn,
      history: Array.from({ length: HISTORY_SIZE }, () => ({ tick: -1, x: 0, y: 0, z: 0 })),
      histHead: 0,
    };
    this.players.set(id, player);

    conn.sendControl({
      t: "welcome",
      playerId: id,
      team,
      tickRate: TICK_HZ,
      snapshotRate: SNAPSHOT_HZ,
      protocol: PROTOCOL_VERSION,
    });
    return id;
  }

  removePlayer(id: number): void {
    this.players.delete(id);
  }

  /** Force a player's feet position + facing (server-authoritative teleport — used
   *  by tests and by future warmup/round placement). No-op if the id is unknown. */
  setPlayerPose(id: number, pos: Vec3, yaw = 0, pitch = 0): void {
    const p = this.players.get(id);
    if (!p) return;
    p.state.pos.x = pos.x;
    p.state.pos.y = pos.y;
    p.state.pos.z = pos.z;
    p.state.vel.x = 0;
    p.state.vel.y = 0;
    p.state.vel.z = 0;
    p.state.yaw = yaw;
    p.state.pitch = pitch;
    p.state.onGround = true;
  }

  onInput(id: number, cmd: PlayerInput): void {
    this.players.get(id)?.buffer.push(cmd);
  }

  /** One authoritative simulation step at fixed `dt` (seconds) for server tick `tick`. */
  step(dt: number, tick: number): void {
    // 0) Respawns due this tick (disabled inside a round — dead stay dead until
    //    the round resets, so a wiped team ends the round).
    if (this.respawnEnabled) {
      for (const p of this.players.values()) {
        if (!p.alive && tick >= p.respawnAtTick) this.respawn(p, tick);
      }
    }

    // 1) Movement + collect fire intents (only on a NEW input, never on starvation repeat).
    const fires: FireIntent[] = [];
    for (const p of this.players.values()) {
      const next = p.buffer.popNext();
      if (next) p.lastInput = next;
      if (p.alive) stepPlayer(p.state, p.lastInput, dt);
      if (next && p.alive && next.buttons & Button.FIRE) {
        fires.push({
          shooterId: p.id,
          fireTick: next.fireTick ?? tick,
          yaw: next.yaw,
          pitch: next.pitch,
        });
      }
    }

    // 2) Record post-movement positions for lag comp.
    for (const p of this.players.values()) {
      const h = p.history[p.histHead]!;
      h.tick = tick;
      h.x = p.state.pos.x;
      h.y = p.state.pos.y;
      h.z = p.state.pos.z;
      p.histHead = (p.histHead + 1) % HISTORY_SIZE;
    }

    // 3) Resolve shots with rewind.
    for (const f of fires) this.resolveFire(f, tick);
  }

  private resolveFire(f: FireIntent, tick: number): void {
    const shooter = this.players.get(f.shooterId);
    if (!shooter || !shooter.alive) return;

    // Validate fire-rate + ammo server-side (client can't bypass).
    if (tick - shooter.lastFireTick < WEAPON_COOLDOWN_TICKS) return;
    if (shooter.ammo <= 0) return;
    shooter.lastFireTick = tick;
    shooter.ammo--;

    // Rewind targets to the tick the shooter was looking at (clamped to the window).
    const rewindTick = clampTick(f.fireTick, tick - LAGCOMP_MAX_TICKS, tick);
    const origin: Vec3 = {
      x: shooter.state.pos.x,
      y: shooter.state.pos.y + EYE_HEIGHT,
      z: shooter.state.pos.z,
    };
    const dir = aimDirection(f.yaw, f.pitch);

    const targets: ShotTarget[] = [];
    for (const other of this.players.values()) {
      if (other.id === shooter.id || !other.alive) continue;
      targets.push({ id: other.id, feet: this.positionAt(other, rewindTick) });
    }

    const res = resolveShot(origin, dir, targets, MAP_COLLIDERS);
    if (res.hitId === null) return; // miss or wall-blocked → no damage, no event

    const victim = this.players.get(res.hitId);
    if (!victim) return;
    victim.hp = Math.max(0, victim.hp - WEAPON_DAMAGE);
    this.emitEvent({
      eventType: EventType.HIT,
      tick,
      attackerId: shooter.id,
      victimId: victim.id,
      weapon: 0,
      damage: WEAPON_DAMAGE,
      hpRemaining: victim.hp,
    });

    if (victim.hp <= 0 && victim.alive) {
      victim.alive = false;
      victim.respawnAtTick = tick + RESPAWN_TICKS;
      this.roundKills[shooter.team]++;
      this.emitEvent({
        eventType: EventType.KILL,
        tick,
        attackerId: shooter.id,
        victimId: victim.id,
        weapon: 0,
        damage: WEAPON_DAMAGE,
        hpRemaining: 0,
      });
    }
  }

  private respawn(p: ServerPlayer, tick: number): void {
    p.alive = true;
    p.hp = MAX_HP;
    p.ammo = WEAPON_MAG_SIZE;
    this.placeAtSpawn(p);
    this.emitEvent({
      eventType: EventType.SPAWN,
      tick,
      attackerId: 0,
      victimId: p.id,
      weapon: 0,
      damage: 0,
      hpRemaining: MAX_HP,
    });
  }

  /** Position of a player at a past tick from the ring buffer (exact, else nearest-before). */
  private positionAt(p: ServerPlayer, tick: number): Vec3 {
    let exact: HistEntry | null = null;
    let before: HistEntry | null = null;
    for (const h of p.history) {
      if (h.tick < 0) continue;
      if (h.tick === tick) {
        exact = h;
        break;
      }
      if (h.tick < tick && (!before || h.tick > before.tick)) before = h;
    }
    const h = exact ?? before;
    return h
      ? { x: h.x, y: h.y, z: h.z }
      : { x: p.state.pos.x, y: p.state.pos.y, z: p.state.pos.z };
  }

  private emitEvent(ev: GameEvent): void {
    const bytes = encodeEvent(ev, this.eventWriter.reset());
    for (const p of this.players.values()) p.conn.sendReliable(bytes);
  }

  broadcastSnapshots(tick: number): void {
    for (const p of this.players.values()) {
      const snap = this.buildSnapshotFor(p, tick);
      p.conn.sendUnreliable(encodeSnapshot(snap, this.snapWriter.reset()));
    }
  }

  private buildSnapshotFor(p: ServerPlayer, tick: number): Snapshot {
    const entities: EntitySnap[] = [];

    for (const id of p.view.keys()) {
      if (!this.players.has(id)) {
        entities.push({ id, flags: EntFlag.DESPAWNED });
        p.view.delete(id);
      }
    }

    for (const other of this.players.values()) {
      const s = other.state;
      const qx = quantizePos(s.pos.x);
      const qy = quantizePos(s.pos.y);
      const qz = quantizePos(s.pos.z);
      const qyaw = quantizeYaw(s.yaw);
      const hp = other.hp;
      const st = other.alive ? EntityState.ALIVE : EntityState.DEAD;

      const sent = p.view.get(other.id);
      const isNew = sent === undefined;
      let flags = 0;
      const e: EntitySnap = { id: other.id, flags: 0 };

      if (isNew) flags |= EntFlag.SPAWNED;
      if (isNew || sent!.x !== qx || sent!.y !== qy || sent!.z !== qz) {
        flags |= EntFlag.POS;
        e.pos = { x: s.pos.x, y: s.pos.y, z: s.pos.z };
      }
      if (isNew || sent!.yaw !== qyaw) {
        flags |= EntFlag.YAW;
        e.yaw = s.yaw;
      }
      if (isNew || sent!.hp !== hp) {
        flags |= EntFlag.HP;
        e.hp = hp;
      }
      if (isNew || sent!.state !== st) {
        flags |= EntFlag.STATE;
        e.state = st;
      }
      if (other.id === p.id) flags |= EntFlag.IS_SELF;

      p.view.set(other.id, { x: qx, y: qy, z: qz, yaw: qyaw, hp, state: st });

      const FIELD_MASK =
        EntFlag.POS | EntFlag.VEL | EntFlag.YAW | EntFlag.HP | EntFlag.STATE | EntFlag.SPAWNED;
      if (flags & FIELD_MASK) {
        e.flags = flags;
        entities.push(e);
      }
    }

    return { tick, ackSeq: p.buffer.lastProcessedSeq & 0xffff, entities };
  }
}

function clampTick(t: number, lo: number, hi: number): number {
  return t < lo ? lo : t > hi ? hi : t;
}
