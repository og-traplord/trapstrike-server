// Match manager (M6): a Redis-backed matchmaking queue + process-per-match
// allocator. Groups MATCH_SIZE players, spawns one game-server process on a free
// port, hands clients their assignment, and reaps the process (frees the port)
// when the match ends.

import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PortPool } from "./port-pool";
import type { Assignment, QueueStore } from "./queue-store";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../../.."); // packages/match-manager/src → repo root
const TSX = resolve(ROOT, "node_modules/.bin/tsx");
const GS_INDEX = resolve(ROOT, "packages/game-server/src/index.ts");

export interface ManagerConfig {
  host: string;
  port: number;
  publicHost: string;
  portBase: number;
  portCount: number;
  matchSize: number;
  enableWt: boolean;
  // game-server lifecycle passthrough
  rounds: number;
  roundMs: number;
  warmupMs: number;
  intermissionMs: number;
  minPlayers: number;
}

interface MatchRecord {
  matchId: string;
  port: number;
  proc: ChildProcess;
  tickets: string[];
  startedAt: number;
}

export class MatchManager {
  private readonly http = createServer((req, res) => void this.handle(req, res));
  private readonly pool: PortPool;
  private readonly matches = new Map<string, MatchRecord>();
  private matchmaker?: NodeJS.Timeout;
  private spawnSeq = 0;

  constructor(
    private readonly cfg: ManagerConfig,
    private readonly queue: QueueStore,
  ) {
    this.pool = new PortPool(cfg.portBase, cfg.portCount);
  }

  async start(): Promise<void> {
    await new Promise<void>((r) => this.http.listen(this.cfg.port, this.cfg.host, () => r()));
    console.log(
      `[mm] listening http://${this.cfg.host}:${this.cfg.port}  matchSize=${this.cfg.matchSize} ports=${this.cfg.portBase}-${this.cfg.portBase + this.cfg.portCount - 1} wt=${this.cfg.enableWt}`,
    );
    this.matchmaker = setInterval(() => void this.matchmake(), 400);
  }

  async stop(): Promise<void> {
    if (this.matchmaker) clearInterval(this.matchmaker);
    for (const m of this.matches.values()) {
      try {
        m.proc.kill("SIGINT");
      } catch {
        /* ignore */
      }
    }
    await new Promise<void>((r) => this.http.close(() => r()));
    await this.queue.close();
  }

  get activeMatches(): number {
    return this.matches.size;
  }

  // Allocate matches while there are enough queued players and a free port.
  private async matchmake(): Promise<void> {
    for (;;) {
      if ((await this.queue.queueLength()) < this.cfg.matchSize) break;
      if (this.pool.available <= 0) {
        console.warn("[mm] all ports busy — matchmaking paused");
        break;
      }
      const tickets = await this.queue.popBatch(this.cfg.matchSize);
      if (tickets.length < this.cfg.matchSize) {
        for (const t of tickets) await this.queue.enqueue(t); // race: put them back
        break;
      }
      await this.allocateMatch(tickets);
    }
  }

  private async allocateMatch(tickets: string[]): Promise<void> {
    const port = this.pool.alloc();
    if (port === null) {
      for (const t of tickets) await this.queue.enqueue(t);
      return;
    }
    const matchId = `m${++this.spawnSeq}-${port}`;

    const proc = spawn(TSX, [GS_INDEX], {
      stdio: "inherit",
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: "0.0.0.0",
        WT: this.cfg.enableWt ? "1" : "0",
        LIFECYCLE: "1",
        MATCH_ID: matchId,
        EXPECTED_PLAYERS: String(this.cfg.matchSize),
        MIN_PLAYERS: String(this.cfg.minPlayers),
        WARMUP_MS: String(this.cfg.warmupMs),
        ROUNDS: String(this.cfg.rounds),
        ROUND_MS: String(this.cfg.roundMs),
        INTERMISSION_MS: String(this.cfg.intermissionMs),
      },
    });

    this.matches.set(matchId, { matchId, port, proc, tickets, startedAt: Date.now() });
    console.log(
      `[mm] ALLOC ${matchId} port=${port} players=${tickets.length} active=${this.matches.size} freePorts=${this.pool.available}`,
    );

    proc.on("exit", (code) => {
      this.matches.delete(matchId);
      this.pool.release(port);
      console.log(
        `[mm] REAP ${matchId} port=${port} exit=${code} active=${this.matches.size} freePorts=${this.pool.available}`,
      );
    });
    proc.on("error", (err) => {
      console.error(`[mm] spawn error ${matchId}: ${err.message}`);
      this.matches.delete(matchId);
      this.pool.release(port);
    });

    const certHash = this.cfg.enableWt ? readCertHash() : undefined;
    const assignment: Assignment = {
      matchId,
      host: this.cfg.publicHost,
      port,
      wsUrl: `ws://${this.cfg.publicHost}:${port}`,
      wtUrl: `https://${this.cfg.publicHost}:${port}/play`,
      certHash,
    };
    for (const t of tickets) await this.queue.setAssignment(t, assignment);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "POST" && url.pathname === "/queue") {
        const ticket = randomUUID();
        await this.queue.enqueue(ticket);
        return json(res, 200, { ticket });
      }
      if (req.method === "GET" && url.pathname.startsWith("/assignment/")) {
        const ticket = decodeURIComponent(url.pathname.slice("/assignment/".length));
        return json(res, 200, await this.queue.getStatus(ticket));
      }
      if (req.method === "GET" && url.pathname === "/health") {
        return json(res, 200, {
          ok: true,
          activeMatches: this.matches.size,
          freePorts: this.pool.available,
        });
      }
      json(res, 404, { error: "not found" });
    } catch (err) {
      json(res, 500, { error: (err as Error).message });
    }
  }
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
  res.end(s);
}

function readCertHash(): string | undefined {
  try {
    return readFileSync(resolve(ROOT, ".wt-dev-cert/hash.txt"), "utf8").trim();
  } catch {
    return undefined;
  }
}
