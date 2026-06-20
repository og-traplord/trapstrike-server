// Match lifecycle FSM (M6): WARMUP → LIVE (rounds loop) → END → (caller exits).
// Drives the Match via its round hooks; coarse timing only, so it stays off the
// per-tick hot path. Only used when LIFECYCLE=1 (the match-manager sets it);
// endless/deathmatch mode (M1–M5) never constructs this.

import { EventType, type GameEvent } from "@trapstrike/protocol";
import type { Match } from "./match";

export interface LifecycleConfig {
  matchId: string;
  expectedPlayers: number; // start immediately once this many are connected
  minPlayers: number; // start after warmupMs if at least this many are present
  warmupMs: number;
  rounds: number;
  roundMs: number;
  intermissionMs: number;
  hardTimeoutMs: number; // give up (and exit) if never enough players
}

type Phase = "warmup" | "live" | "intermission" | "end";

const ev = (eventType: number, a: number, b: number, c: number): GameEvent => ({
  eventType,
  tick: 0,
  attackerId: a,
  victimId: b,
  weapon: c,
  damage: 0,
  hpRemaining: 0,
});

export class MatchLifecycle {
  private phase: Phase = "warmup";
  private round = 0;
  private scores: [number, number] = [0, 0];
  private poll?: NodeJS.Timeout;
  private timers: NodeJS.Timeout[] = [];
  private bootAt = Date.now();
  private roundStartAt = 0;
  private roundDeadline = 0;

  constructor(
    private readonly match: Match,
    private readonly cfg: LifecycleConfig,
    private readonly onEnd: () => void,
    private readonly log: (m: string) => void,
  ) {}

  start(): void {
    this.log(
      `lifecycle WARMUP match=${this.cfg.matchId} (need ${this.cfg.expectedPlayers}, or ≥${this.cfg.minPlayers} after ${this.cfg.warmupMs}ms)`,
    );
    this.poll = setInterval(() => this.tick(), 250);
  }

  stop(): void {
    if (this.poll) clearInterval(this.poll);
    for (const t of this.timers) clearTimeout(t);
  }

  private tick(): void {
    const now = Date.now();
    if (this.phase === "warmup") {
      const n = this.match.playerCount;
      const warmedUp = now - this.bootAt >= this.cfg.warmupMs;
      if (n >= this.cfg.expectedPlayers || (warmedUp && n >= this.cfg.minPlayers)) {
        this.beginLive();
      } else if (now - this.bootAt >= this.cfg.hardTimeoutMs) {
        this.log(`lifecycle WARMUP timed out with ${n} players — ending`);
        this.endMatch();
      }
      return;
    }
    if (this.phase === "live") {
      const [a, b] = this.match.aliveByTeam();
      const elapsed = now - this.roundStartAt;
      const wiped = elapsed > 1000 && (a === 0 || b === 0);
      const timeUp = now >= this.roundDeadline;
      if (wiped) this.endRound(a === 0 ? 1 : 0);
      else if (timeUp) this.endRound(this.scoreWinner());
    }
  }

  private beginLive(): void {
    this.phase = "live";
    this.round = 0;
    this.scores = [0, 0];
    this.match.setRespawnEnabled(false); // round mode: dead stay dead until reset
    this.log(`lifecycle LIVE players=${this.match.playerCount} rounds=${this.cfg.rounds}`);
    this.startRound();
  }

  private startRound(): void {
    this.round++;
    this.match.startRound();
    this.roundStartAt = Date.now();
    this.roundDeadline = this.roundStartAt + this.cfg.roundMs;
    this.phase = "live";
    this.log(`lifecycle ROUND ${this.round}/${this.cfg.rounds} start`);
    this.match.broadcastEvent(ev(EventType.ROUND_START, this.round, 0, 0));
  }

  private scoreWinner(): number {
    const [ka, kb] = this.match.roundScore;
    return kb > ka ? 1 : 0; // ties → team 0
  }

  private endRound(winner: number): void {
    if (this.phase !== "live") return;
    this.scores[winner]++;
    this.log(
      `lifecycle ROUND ${this.round} end → team ${winner} wins (match ${this.scores[0]}-${this.scores[1]})`,
    );
    this.match.broadcastEvent(ev(EventType.ROUND_END, winner, this.scores[0], this.scores[1]));
    if (this.round >= this.cfg.rounds) {
      this.endMatch();
      return;
    }
    this.phase = "intermission";
    this.timers.push(setTimeout(() => this.startRound(), this.cfg.intermissionMs));
  }

  private endMatch(): void {
    if (this.phase === "end") return;
    this.phase = "end";
    const winner =
      this.scores[0] === this.scores[1] ? -1 : this.scores[0] > this.scores[1] ? 0 : 1;
    this.log(
      `lifecycle END match=${this.cfg.matchId} final ${this.scores[0]}-${this.scores[1]} winner=${winner < 0 ? "draw" : `team ${winner}`}`,
    );
    this.stop();
    // Brief flush so the final reliable events go out before we tear down.
    setTimeout(() => this.onEnd(), 500);
  }
}
