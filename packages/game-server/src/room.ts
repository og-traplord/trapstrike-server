import { MsgType, decodeInputCmd } from "@trapstrike/protocol";
import { Match } from "./match";
import type { TransportConnection } from "./transport/types";

// A Room is a passcode-keyed space with two phases:
//   LOBBY  — players gather, pick a team, ready up; the host presses GO.
//   MATCH  — the authoritative Match runs (movement + combat today; rounds/bots later).
// Lobby messaging is JSON control frames (Law 3: JSON for lobby/handshake). When the
// match starts, each connection's binary InputCmd channel is wired to the Match and the
// client switches to the game on the `welcome` control it receives from Match.addPlayer.

interface LobbyPlayer {
  conn: TransportConnection;
  id: number;
  name: string;
  team: 0 | 1;
  ready: boolean;
}

export class Room {
  readonly code: string;
  phase: "lobby" | "match" = "lobby";
  match: Match | null = null;

  private lobby = new Map<number, LobbyPlayer>();
  private hostId = -1;
  private matchIdByConn = new Map<number, number>();

  constructor(code: string) {
    this.code = code;
  }

  get playerCount(): number {
    return this.phase === "match" && this.match ? this.match.playerCount : this.lobby.size;
  }

  /** A new connection arrives at this room. */
  addConn(conn: TransportConnection): void {
    conn.onClose(() => this.removeConn(conn.id));

    if (this.phase === "match" && this.match) {
      // Join in progress — drop straight into the running match (auto team).
      this.joinMatch(conn);
      console.log(`[room ${this.code}] ${conn.id} joined match in progress`);
      return;
    }

    if (this.hostId < 0) this.hostId = conn.id;
    let t0 = 0;
    let t1 = 0;
    for (const p of this.lobby.values()) p.team === 0 ? t0++ : t1++;
    const lp: LobbyPlayer = { conn, id: conn.id, name: `P${conn.id}`, team: t0 <= t1 ? 0 : 1, ready: false };
    this.lobby.set(conn.id, lp);
    conn.onControl((msg) => this.onLobbyControl(conn.id, msg));
    console.log(`[room ${this.code}] ${conn.id} joined lobby (size=${this.lobby.size}, host=${this.hostId})`);
    this.broadcastLobby();
  }

  private onLobbyControl(id: number, msg: unknown): void {
    if (this.phase !== "lobby") return;
    const p = this.lobby.get(id);
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
        return; // tryStart broadcasts/transitions
    }
    this.broadcastLobby();
  }

  private tryStart(): void {
    if (this.lobby.size < 1) return;
    for (const p of this.lobby.values()) if (!p.ready) return; // everyone must be ready
    this.startMatch();
  }

  private startMatch(): void {
    const match = new Match();
    this.match = match;
    this.phase = "match";
    // Tell lobby clients we're going live, THEN add each to the match (which sends
    // the per-player `welcome` that flips the client into the game).
    for (const p of this.lobby.values()) p.conn.sendControl({ t: "matchStart", room: this.code });
    for (const p of this.lobby.values()) {
      const mid = match.addPlayer(p.conn, p.team);
      this.matchIdByConn.set(p.id, mid);
      this.wireInput(p.conn, mid);
    }
    console.log(`[room ${this.code}] MATCH START with ${this.lobby.size} players`);
  }

  /** A late connection joins a running match (no team choice — auto-balanced). */
  private joinMatch(conn: TransportConnection): void {
    const mid = this.match!.addPlayer(conn);
    this.matchIdByConn.set(conn.id, mid);
    this.wireInput(conn, mid);
  }

  private wireInput(conn: TransportConnection, matchId: number): void {
    conn.onMessage((data) => {
      if (data.length === 0) return;
      if (data[0] === MsgType.InputCmd) {
        try {
          this.match!.onInput(matchId, decodeInputCmd(data));
        } catch {
          /* drop malformed input */
        }
      }
    });
  }

  removeConn(id: number): void {
    if (this.match) {
      const mid = this.matchIdByConn.get(id);
      if (mid !== undefined) {
        this.match.removePlayer(mid);
        this.matchIdByConn.delete(id);
      }
    }
    const wasInLobby = this.lobby.delete(id);
    if (id === this.hostId) {
      const next = this.lobby.keys().next();
      this.hostId = next.done ? -1 : next.value;
    }
    if (this.phase === "lobby" && wasInLobby) this.broadcastLobby();
  }

  private broadcastLobby(): void {
    const players = [...this.lobby.values()].map((p) => ({ id: p.id, name: p.name, team: p.team, ready: p.ready }));
    const canStart = players.length > 0 && players.every((p) => p.ready);
    for (const p of this.lobby.values()) {
      p.conn.sendControl({ t: "lobby", room: this.code, you: p.id, host: this.hostId, canStart, players });
    }
  }

  /** LIFECYCLE/M6-demo only: skip the lobby and run a match immediately. */
  startEmptyMatch(): Match {
    this.match = new Match();
    this.phase = "match";
    return this.match;
  }

  // --- match tick passthrough (no-op while in lobby) ---
  step(dt: number, tick: number): void {
    if (this.phase === "match" && this.match) this.match.step(dt, tick);
  }
  broadcastSnapshots(tick: number): void {
    if (this.phase === "match" && this.match) this.match.broadcastSnapshots(tick);
  }
}
