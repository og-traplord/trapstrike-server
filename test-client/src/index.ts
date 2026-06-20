// Headless test client.
//   M2 prediction + reconciliation · M3 interpolation · M4 fire-intent + events.
//   M5 — runs over WebTransport (primary) or WebSocket (fallback), identically:
//        the game logic talks only to a ClientTransport (see transport.ts).
// The client sends INTENT ONLY (Law 1); the server owns every result.
//
// Knobs: --lat <ms> --jitter <ms> --drop <0..1>  --fire --fire-interval <ms>
//        --url ws://… --wt-url https://… --cert-hash <hex> --force-ws

import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EYE_HEIGHT,
  HITBOX_FOOT,
  HITBOX_HEAD,
  TAU,
  TICK_DT_MS,
  TICK_DT_S,
  type PlayerInput,
  type PlayerState,
  makePlayerState,
  stepPlayer,
} from "@trapstrike/shared";
import {
  Button,
  EntFlag,
  EntityState,
  EventType,
  type GameEvent,
  MsgType,
  type Snapshot,
  decodeEvent,
  decodeSnapshot,
  encodeInputCmd,
} from "@trapstrike/protocol";
import { type ClientTransport, connectWithFallback } from "./transport";

const INTERP_DELAY_MS = 100;
const EXTRAPOLATE_MAX_MS = 120;
const RENDER_DT_MS = 1000 / 60;
const BUFFER_KEEP_MS = 1000;

interface Args {
  name: string;
  url: string;
  wtUrl?: string;
  certHashHex?: string;
  forceWs: boolean;
  durationMs: number;
  dir: "circle" | "x" | "z";
  latMs: number;
  jitterMs: number;
  dropProb: number;
  fire: boolean;
  fireIntervalMs: number;
}

interface EntView {
  x: number;
  y: number;
  z: number;
  yaw: number;
  hp: number;
  state: number;
}
interface Sample {
  serverMs: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
}
interface StepAcc {
  sum: number;
  max: number;
  n: number;
  zero: number;
}
interface RenderMetric {
  prevInterp?: { x: number; z: number };
  prevRaw?: { x: number; z: number };
  interp: StepAcc;
  raw: StepAcc;
}

const SEQ_MOD = 0x10000;
function seqGreaterThan(a: number, b: number): boolean {
  const d = (a - b + SEQ_MOD) % SEQ_MOD;
  return d !== 0 && d < 0x8000;
}
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
function lerpAngle(a: number, b: number, t: number): number {
  let d = ((b - a) % TAU + TAU) % TAU;
  if (d > Math.PI) d -= TAU;
  return a + d * t;
}
const dist2d = (ax: number, az: number, bx: number, bz: number): number =>
  Math.hypot(ax - bx, az - bz);

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function sampleAt(buf: Sample[], t: number): { x: number; y: number; z: number; yaw: number } | null {
  if (buf.length === 0) return null;
  const first = buf[0]!;
  const last = buf[buf.length - 1]!;
  if (t <= first.serverMs) return { x: first.x, y: first.y, z: first.z, yaw: first.yaw };
  if (t >= last.serverMs) {
    const ahead = t - last.serverMs;
    if (buf.length >= 2 && ahead <= EXTRAPOLATE_MAX_MS) {
      const prev = buf[buf.length - 2]!;
      const span = last.serverMs - prev.serverMs;
      if (span > 0) {
        const f = ahead / span;
        return {
          x: last.x + (last.x - prev.x) * f,
          y: last.y,
          z: last.z + (last.z - prev.z) * f,
          yaw: last.yaw,
        };
      }
    }
    return { x: last.x, y: last.y, z: last.z, yaw: last.yaw };
  }
  for (let i = 0; i < buf.length - 1; i++) {
    const a = buf[i]!;
    const b = buf[i + 1]!;
    if (t >= a.serverMs && t <= b.serverMs) {
      const span = b.serverMs - a.serverMs;
      const alpha = span > 0 ? (t - a.serverMs) / span : 0;
      return {
        x: lerp(a.x, b.x, alpha),
        y: lerp(a.y, b.y, alpha),
        z: lerp(a.z, b.z, alpha),
        yaw: lerpAngle(a.yaw, b.yaw, alpha),
      };
    }
  }
  return { x: last.x, y: last.y, z: last.z, yaw: last.yaw };
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string, def: string): string => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : def;
  };
  const opt = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : undefined;
  };
  const has = (flag: string): boolean => argv.includes(flag);
  return {
    name: get("--name", "client"),
    url: get("--url", `ws://127.0.0.1:${process.env.PORT ?? 8080}`),
    wtUrl: opt("--wt-url"),
    certHashHex: opt("--cert-hash"),
    forceWs: has("--force-ws"),
    durationMs: Number(get("--duration", "5000")),
    dir: get("--dir", "circle") as Args["dir"],
    latMs: Number(get("--lat", "0")),
    jitterMs: Number(get("--jitter", "0")),
    dropProb: Number(get("--drop", "0")),
    fire: has("--fire"),
    fireIntervalMs: Number(get("--fire-interval", "450")),
  };
}

class GameClient {
  private playerId = -1;
  private seq = 1;
  private sendTimer?: NodeJS.Timeout;
  private renderTimer?: NodeJS.Timeout;
  private fireTimer?: NodeJS.Timeout;

  private predicted: PlayerState = makePlayerState();
  private pending: PlayerInput[] = [];
  private anchored = false;

  private readonly world = new Map<number, EntView>();

  private readonly interpBuf = new Map<number, Sample[]>();
  private readonly renderPos = new Map<number, { x: number; y: number; z: number; yaw: number }>();
  private readonly metrics = new Map<number, RenderMetric>();
  private renderServerMs = -1;
  private newestServerMs = 0;
  private lastRenderAt = -1;

  private yaw: number;
  private wantFire = false;

  private snapsSeen = 0;
  private inputsSent = 0;
  private inputsDropped = 0;
  private snapsDropped = 0;
  private corrSum = 0;
  private corrCount = 0;
  private corrMax = 0;
  private shotsFired = 0;
  private hitsDealt = 0;
  private killsDealt = 0;
  private hitsTaken = 0;
  private deaths = 0;
  private finished = false;

  constructor(
    private readonly args: Args,
    private readonly transport: ClientTransport,
  ) {
    this.yaw = args.dir === "x" ? Math.PI / 2 : 0;
  }

  start(): void {
    console.log(`[${this.args.name}] connected via ${this.transport.kind.toUpperCase()}`);
    this.transport.onControl((m) => this.onControl(m));
    this.transport.onUnreliable((d) => {
      if (Math.random() < this.args.dropProb) {
        this.snapsDropped++;
        return;
      }
      this.over(() => this.handleSnapshot(d));
    });
    this.transport.onReliable((d) => this.delayOnly(() => this.handleEvent(d)));
    this.transport.onClose(() => {
      console.log(`[${this.args.name}] transport closed`);
      this.finish(); // e.g. the match ended and the server exited
    });

    this.sendTimer = setInterval(() => this.tick(), TICK_DT_MS);
    this.renderTimer = setInterval(() => this.renderFrame(), RENDER_DT_MS);
    if (this.args.fire) {
      this.fireTimer = setInterval(() => {
        this.wantFire = true;
      }, this.args.fireIntervalMs);
    }
    setTimeout(() => this.finish(), this.args.durationMs);
  }

  private delay(): number {
    return this.args.latMs + (this.args.jitterMs > 0 ? Math.random() * this.args.jitterMs : 0);
  }
  private over(fn: () => void): void {
    const d = this.delay();
    if (d <= 0) fn();
    else setTimeout(fn, d);
  }
  private delayOnly(fn: () => void): void {
    const d = this.delay();
    if (d <= 0) fn();
    else setTimeout(fn, d);
  }

  private onControl(m: unknown): void {
    const msg = m as { t?: string; playerId?: number; tickRate?: number; snapshotRate?: number };
    if (msg.t === "welcome" && msg.playerId !== undefined) {
      this.playerId = msg.playerId;
      console.log(
        `[${this.args.name}] welcome: playerId=${this.playerId} tick=${msg.tickRate}Hz snap=${msg.snapshotRate}Hz`,
      );
    }
  }

  private tick(): void {
    if (this.args.dir === "circle") this.yaw += 0.05;
    const cmd: PlayerInput = {
      seq: this.seq++ & 0xffff,
      dtMs: Math.round(TICK_DT_MS),
      moveX: 0,
      moveZ: 1,
      yaw: this.yaw,
      pitch: 0,
      buttons: 0,
    };
    this.maybeFire(cmd);

    stepPlayer(this.predicted, cmd, TICK_DT_S);
    this.pending.push(cmd);

    const bytes = encodeInputCmd(cmd);
    if (Math.random() < this.args.dropProb) {
      this.inputsDropped++;
      return;
    }
    this.inputsSent++;
    const d = this.delay();
    if (d <= 0) this.transport.sendUnreliable(bytes);
    else setTimeout(() => this.transport.sendUnreliable(bytes), d);
  }

  private maybeFire(cmd: PlayerInput): void {
    if (!this.wantFire) return;
    this.wantFire = false;
    if (this.renderServerMs < 0) return;
    const self = this.world.get(this.playerId);
    if (self && self.state === EntityState.DEAD) return;

    let targetId = -1;
    let bestD = Number.POSITIVE_INFINITY;
    for (const [id, v] of this.renderPos) {
      const d = dist2d(this.predicted.pos.x, this.predicted.pos.z, v.x, v.z);
      if (d < bestD) {
        bestD = d;
        targetId = id;
      }
    }
    if (targetId < 0) return;
    const tg = this.renderPos.get(targetId)!;
    const eyeY = this.predicted.pos.y + EYE_HEIGHT;
    const chestY = tg.y + (HITBOX_FOOT + HITBOX_HEAD) / 2;
    const dx = tg.x - this.predicted.pos.x;
    const dz = tg.z - this.predicted.pos.z;
    cmd.yaw = Math.atan2(dx, dz);
    cmd.pitch = Math.atan2(chestY - eyeY, Math.hypot(dx, dz));
    cmd.buttons |= Button.FIRE;
    cmd.fireTick = Math.round(this.renderServerMs / TICK_DT_MS);
    this.shotsFired++;
  }

  private handleEvent(data: Uint8Array): void {
    if (data.length === 0 || data[0] !== MsgType.Event) return;
    let ev: GameEvent;
    try {
      ev = decodeEvent(data);
    } catch {
      return;
    }
    const n = this.args.name;
    if (ev.eventType === EventType.HIT) {
      if (ev.attackerId === this.playerId) this.hitsDealt++;
      if (ev.victimId === this.playerId) this.hitsTaken++;
      console.log(`[${n}] EVENT HIT ${ev.attackerId}→${ev.victimId} dmg=${ev.damage} victimHp=${ev.hpRemaining}`);
    } else if (ev.eventType === EventType.KILL) {
      if (ev.attackerId === this.playerId) this.killsDealt++;
      if (ev.victimId === this.playerId) this.deaths++;
      console.log(`[${n}] EVENT KILL ${ev.attackerId}→${ev.victimId}`);
    } else if (ev.eventType === EventType.SPAWN) {
      console.log(`[${n}] EVENT SPAWN ${ev.victimId}`);
    }
  }

  private handleSnapshot(data: Uint8Array): void {
    if (data.length === 0 || data[0] !== MsgType.Snapshot) return;
    const snap = decodeSnapshot(data);
    this.applyToWorld(snap);
    this.reconcile(snap);
    this.bufferRemotes(snap);
    this.snapsSeen++;
    if (this.snapsSeen % 5 === 0) this.print(snap);
  }

  private applyToWorld(snap: Snapshot): void {
    for (const e of snap.entities) {
      if (e.flags & EntFlag.DESPAWNED) {
        this.world.delete(e.id);
        continue;
      }
      let v = this.world.get(e.id);
      if (!v) {
        v = { x: 0, y: 0, z: 0, yaw: 0, hp: 0, state: 0 };
        this.world.set(e.id, v);
      }
      if (e.pos) {
        v.x = e.pos.x;
        v.y = e.pos.y;
        v.z = e.pos.z;
      }
      if (e.yaw !== undefined) v.yaw = e.yaw;
      if (e.hp !== undefined) v.hp = e.hp;
      if (e.state !== undefined) v.state = e.state;
    }
  }

  private reconcile(snap: Snapshot): void {
    if (this.playerId < 0) return;
    const srv = this.world.get(this.playerId);
    if (!srv) return;
    this.pending = this.pending.filter((p) => seqGreaterThan(p.seq, snap.ackSeq));
    const beforeX = this.predicted.pos.x;
    const beforeZ = this.predicted.pos.z;
    this.predicted.pos.x = srv.x;
    this.predicted.pos.y = srv.y;
    this.predicted.pos.z = srv.z;
    this.predicted.yaw = srv.yaw;
    for (const inp of this.pending) stepPlayer(this.predicted, inp, TICK_DT_S);
    const correction = Math.hypot(this.predicted.pos.x - beforeX, this.predicted.pos.z - beforeZ);
    if (!this.anchored) this.anchored = true;
    else {
      this.corrSum += correction;
      this.corrCount++;
      if (correction > this.corrMax) this.corrMax = correction;
    }
  }

  private bufferRemotes(snap: Snapshot): void {
    const serverMs = snap.tick * TICK_DT_MS;
    if (serverMs > this.newestServerMs) this.newestServerMs = serverMs;
    if (this.renderServerMs < 0) this.renderServerMs = serverMs - INTERP_DELAY_MS;
    for (const e of snap.entities) {
      if (e.id === this.playerId) continue;
      if (e.flags & EntFlag.DESPAWNED) {
        this.interpBuf.delete(e.id);
        this.renderPos.delete(e.id);
        continue;
      }
      const v = this.world.get(e.id);
      if (!v) continue;
      let buf = this.interpBuf.get(e.id);
      if (!buf) {
        buf = [];
        this.interpBuf.set(e.id, buf);
      }
      const tail = buf[buf.length - 1];
      if (tail && serverMs <= tail.serverMs) continue;
      buf.push({ serverMs, x: v.x, y: v.y, z: v.z, yaw: v.yaw });
      const cutoff = serverMs - BUFFER_KEEP_MS;
      while (buf.length > 2 && buf[0]!.serverMs < cutoff) buf.shift();
    }
  }

  private renderFrame(): void {
    const now = performance.now();
    const dt = this.lastRenderAt < 0 ? 0 : now - this.lastRenderAt;
    this.lastRenderAt = now;
    if (this.renderServerMs < 0) return;
    this.renderServerMs += dt;
    const target = this.newestServerMs - INTERP_DELAY_MS;
    this.renderServerMs += (target - this.renderServerMs) * 0.1;

    for (const [id, buf] of this.interpBuf) {
      const s = sampleAt(buf, this.renderServerMs);
      if (!s) continue;
      this.renderPos.set(id, s);
      const m = this.metricFor(id);
      if (m.prevInterp) addStep(m.interp, dist2d(m.prevInterp.x, m.prevInterp.z, s.x, s.z));
      m.prevInterp = { x: s.x, z: s.z };
      const raw = this.world.get(id);
      if (raw) {
        if (m.prevRaw) addStep(m.raw, dist2d(m.prevRaw.x, m.prevRaw.z, raw.x, raw.z));
        m.prevRaw = { x: raw.x, z: raw.z };
      }
    }
  }

  private metricFor(id: number): RenderMetric {
    let m = this.metrics.get(id);
    if (!m) {
      m = { interp: { sum: 0, max: 0, n: 0, zero: 0 }, raw: { sum: 0, max: 0, n: 0, zero: 0 } };
      this.metrics.set(id, m);
    }
    return m;
  }

  private print(snap: Snapshot): void {
    const p = this.predicted.pos;
    const selfHp = this.world.get(this.playerId)?.hp ?? "?";
    const peers = [...this.renderPos.entries()]
      .map(([id, v]) => `${id}:(${v.x.toFixed(1)},${v.z.toFixed(1)})hp${this.world.get(id)?.hp ?? "?"}`)
      .join(" ");
    console.log(
      `[${this.args.name}] t=${snap.tick} ack=${snap.ackSeq} self=(${p.x.toFixed(1)},${p.z.toFixed(1)})hp${selfHp} peers=[${peers || "—"}]`,
    );
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    if (this.sendTimer) clearInterval(this.sendTimer);
    if (this.renderTimer) clearInterval(this.renderTimer);
    if (this.fireTimer) clearInterval(this.fireTimer);
    const avgCorr = this.corrCount > 0 ? this.corrSum / this.corrCount : 0;
    console.log(
      `[${this.args.name}] DONE via ${this.transport.kind.toUpperCase()} lat=${this.args.latMs}ms drop=${this.args.dropProb} ` +
        `selfCorrection(avg/max)=${avgCorr.toFixed(3)}/${this.corrMax.toFixed(3)}m ` +
        `| shots=${this.shotsFired} hitsDealt=${this.hitsDealt} killsDealt=${this.killsDealt} ` +
        `hitsTaken=${this.hitsTaken} deaths=${this.deaths}`,
    );
    for (const [id, m] of this.metrics) {
      console.log(
        `[${this.args.name}]   peer ${id} render-step  ` +
          `INTERP avg=${avg(m.interp).toFixed(3)} max=${m.interp.max.toFixed(3)} burstiness=${ratio(m.interp).toFixed(1)} zero=${pct(m.interp).toFixed(0)}%  |  ` +
          `RAW avg=${avg(m.raw).toFixed(3)} max=${m.raw.max.toFixed(3)} burstiness=${ratio(m.raw).toFixed(1)} zero=${pct(m.raw).toFixed(0)}%`,
      );
    }
    this.transport.close();
    setTimeout(() => process.exit(0), 150);
  }
}

function addStep(acc: StepAcc, d: number): void {
  acc.sum += d;
  acc.n++;
  if (d > acc.max) acc.max = d;
  if (d < 1e-4) acc.zero++;
}
const avg = (a: StepAcc): number => (a.n > 0 ? a.sum / a.n : 0);
const ratio = (a: StepAcc): number => (a.sum > 0 ? a.max / (a.sum / a.n) : 0);
const pct = (a: StepAcc): number => (a.n > 0 ? (a.zero / a.n) * 100 : 0);

export { GameClient, hexToBytes };
export type { Args };

async function main(): Promise<void> {
  const args = parseArgs();
  const transport = await connectWithFallback({
    wsUrl: args.url,
    wtUrl: args.wtUrl,
    certHash: args.certHashHex ? hexToBytes(args.certHashHex) : undefined,
    forceWs: args.forceWs,
  });
  new GameClient(args, transport).start();
}

// Only auto-run when executed directly (so mm-client.ts can import GameClient).
const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error("[client] fatal:", err);
    process.exit(1);
  });
}
