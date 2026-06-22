import { Match } from "./match";
import type { TransportConnection } from "./transport/types";

// A Room is a passcode-keyed space with two phases:
//   LOBBY  — players gather, pick a team, ready up; the host presses GO.
//   MATCH  — HOST-AUTHORITATIVE: the host's browser runs the whole game (the original
//            Engine: bots, rounds, reload, plant/defuse) and STREAMS it to joiners.
//            The server only RELAYS: host → all joiners (snapshots/events as-is), and
//            each joiner → host (their input, tagged with [0xF0][senderId] so the host
//            knows whose it is). Everyone sees the SAME bots / 5v5.
//
// Lobby messaging is JSON control frames (Law 3). The server never simulates the match
// here (that's the host) — the Match class is used only by the LIFECYCLE/M6 demo path.

const RELAY_INPUT = 0xf0; // server→host envelope tag (must match the client constant)

interface RoomPlayer {
  conn: TransportConnection;
  id: number;
  name: string;
  team: 0 | 1;
  ready: boolean;
}

export class Room {
  readonly code: string;
  phase: "lobby" | "match" = "lobby";
  match: Match | null = null; // LIFECYCLE/demo only

  private players = new Map<number, RoomPlayer>();
  private hostId = -1;

  constructor(code: string) {
    this.code = code;
  }

  get playerCount(): number {
    return this.match ? this.match.playerCount : this.players.size;
  }

  addConn(conn: TransportConnection): void {
    conn.onClose(() => this.removeConn(conn.id));

    if (this.match) {
      // LIFECYCLE/demo path: straight into the server-sim match.
      this.match.addPlayer(conn);
      return;
    }

    if (this.hostId < 0) this.hostId = conn.id;
    let t0 = 0;
    let t1 = 0;
    for (const p of this.players.values()) p.team === 0 ? t0++ : t1++;
    const rp: RoomPlayer = { conn, id: conn.id, name: `P${conn.id}`, team: t0 <= t1 ? 0 : 1, ready: false };
    this.players.set(conn.id, rp);

    if (this.phase === "match") {
      // Join in progress — relay this joiner immediately + tell the host to add them.
      this.sendMatchStart(rp);
      this.wireRelay(rp);
      this.broadcastRoster();
      console.log(`[room ${this.code}] ${conn.id} joined match in progress`);
    } else {
      conn.onControl((msg) => this.onLobbyControl(conn.id, msg));
      console.log(`[room ${this.code}] ${conn.id} joined lobby (size=${this.players.size}, host=${this.hostId})`);
      this.broadcastLobby();
    }
  }

  // --- lobby ---

  private onLobbyControl(id: number, msg: unknown): void {
    if (this.phase !== "lobby") return;
    const p = this.players.get(id);
    if (!p) return;
    const m = msg as { t?: string; name?: string; team?: number; ready?: boolean };
    switch (m.t) {
      case "name":
        if (typeof m.name === "string" && m.name.trim()) p.name = m.name.trim().slice(0, 14);
        break;
      case "team":
        if (m.team === 0 || m.team === 1) p.team = m.team;
        break;
      case "ready":
        p.ready = !!m.ready;
        break;
      case "start":
        if (id === this.hostId) this.tryStart();
        return;
    }
    this.broadcastLobby();
  }

  private tryStart(): void {
    if (this.players.size < 1) return;
    for (const p of this.players.values()) if (!p.ready) return;
    this.startMatch();
  }

  private broadcastLobby(): void {
    const players = [...this.players.values()].map((p) => ({ id: p.id, name: p.name, team: p.team, ready: p.ready }));
    const canStart = players.length > 0 && players.every((p) => p.ready);
    for (const p of this.players.values()) {
      p.conn.sendControl({ t: "lobby", room: this.code, you: p.id, host: this.hostId, canStart, players });
    }
  }

  // --- host-authoritative match (relay) ---

  private startMatch(): void {
    this.phase = "match";
    for (const p of this.players.values()) {
      this.sendMatchStart(p);
      this.wireRelay(p);
    }
    console.log(`[room ${this.code}] MATCH START (host-authoritative) — host=${this.hostId}, ${this.players.size} players`);
  }

  /** Tell a player the match is starting + who's in it (host builds entities from this). */
  private sendMatchStart(p: RoomPlayer): void {
    p.conn.sendControl({
      t: "matchStart",
      room: this.code,
      you: p.id,
      host: this.hostId,
      isHost: p.id === this.hostId,
      roster: [...this.players.values()].map((q) => ({ id: q.id, name: q.name, team: q.team })),
    });
  }

  private broadcastRoster(): void {
    const roster = [...this.players.values()].map((q) => ({ id: q.id, name: q.name, team: q.team }));
    // Host needs the updated roster to add/drop entities; joiners can ignore.
    this.players.get(this.hostId)?.conn.sendControl({ t: "roster", host: this.hostId, roster });
  }

  /** Relay wiring for one connection in the match. */
  private wireRelay(p: RoomPlayer): void {
    const isHost = p.id === this.hostId;
    p.conn.onMessage((data) => {
      if (isHost) {
        // Host's stream (snapshots/events) → every joiner, as-is.
        for (const q of this.players.values()) if (q.id !== this.hostId) q.conn.sendUnreliable(data);
      } else {
        // Joiner's input → host, tagged with [0xF0][senderId u16].
        const host = this.players.get(this.hostId);
        if (!host) return;
        const framed = new Uint8Array(3 + data.length);
        framed[0] = RELAY_INPUT;
        framed[1] = p.id & 0xff;
        framed[2] = (p.id >> 8) & 0xff;
        framed.set(data, 3);
        host.conn.sendUnreliable(framed);
      }
    });
    p.conn.onControl((msg) => {
      // In-match JSON (e.g. host round/killfeed events) → relay the same way.
      if (isHost) {
        for (const q of this.players.values()) if (q.id !== this.hostId) q.conn.sendControl(msg as object);
      } else {
        this.players.get(this.hostId)?.conn.sendControl({ t: "relay", from: p.id, msg });
      }
    });
  }

  removeConn(id: number): void {
    if (this.match) this.match.removePlayer(id);
    const existed = this.players.delete(id);
    if (id === this.hostId) {
      // Host left. In match: the match is over (host owned the sim). In lobby: hand off.
      const next = this.players.keys().next();
      this.hostId = next.done ? -1 : next.value;
      if (this.phase === "match" && existed) {
        for (const q of this.players.values()) q.conn.sendControl({ t: "hostLeft" });
      }
    }
    if (this.phase === "lobby" && existed) this.broadcastLobby();
    else if (this.phase === "match" && existed) this.broadcastRoster();
  }

  /** LIFECYCLE/M6-demo only: skip the lobby and run a server-sim match immediately. */
  startEmptyMatch(): Match {
    this.match = new Match();
    this.phase = "match";
    return this.match;
  }

  // The server doesn't tick host-authoritative rooms (the host drives the game). These
  // only do work for the LIFECYCLE/demo Match.
  step(dt: number, tick: number): void {
    if (this.match) this.match.step(dt, tick);
  }
  broadcastSnapshots(tick: number): void {
    if (this.match) this.match.broadcastSnapshots(tick);
  }
}
