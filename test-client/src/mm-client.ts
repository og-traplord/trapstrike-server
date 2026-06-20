// Matchmaking client (M6): queue at the manager, wait for an assignment, then
// connect to the allocated game-server and play. Reuses GameClient unchanged.
//
// Usage: tsx test-client/src/mm-client.ts --name P1 --manager http://127.0.0.1:9000 [--fire] [--dir x]

import { setTimeout as sleep } from "node:timers/promises";
import { type ClientTransport, type ConnectOptions, connectWithFallback } from "./transport";
import { type Args, GameClient, hexToBytes } from "./index";

/** The game-server may still be booting when we get the assignment — retry. */
async function connectWithRetry(opts: ConnectOptions, attempts = 20, delayMs = 300): Promise<ClientTransport> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await connectWithFallback(opts);
    } catch (err) {
      lastErr = err;
      await sleep(delayMs);
    }
  }
  throw lastErr;
}

interface MMArgs {
  name: string;
  manager: string;
  dir: "x" | "z" | "circle";
  fire: boolean;
  forceWs: boolean;
  durationMs: number;
}

interface Assignment {
  matchId: string;
  host: string;
  port: number;
  wsUrl: string;
  wtUrl: string;
  certHash?: string;
}

function parse(): MMArgs {
  const argv = process.argv.slice(2);
  const get = (f: string, d: string): string => {
    const i = argv.indexOf(f);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : d;
  };
  return {
    name: get("--name", "mmc"),
    manager: get("--manager", "http://127.0.0.1:9000"),
    dir: get("--dir", "x") as MMArgs["dir"],
    fire: argv.includes("--fire"),
    forceWs: argv.includes("--force-ws"),
    durationMs: Number(get("--duration", "60000")),
  };
}

async function main(): Promise<void> {
  const a = parse();

  const queued = (await (await fetch(`${a.manager}/queue`, { method: "POST" })).json()) as {
    ticket: string;
  };
  console.log(`[${a.name}] queued ticket=${queued.ticket.slice(0, 8)}`);

  let assign: Assignment | undefined;
  for (let i = 0; i < 300; i++) {
    const s = (await (await fetch(`${a.manager}/assignment/${queued.ticket}`)).json()) as {
      state: string;
      assignment?: Assignment;
    };
    if (s.state === "matched" && s.assignment) {
      assign = s.assignment;
      break;
    }
    await sleep(200);
  }
  if (!assign) {
    console.error(`[${a.name}] never matched`);
    process.exit(1);
  }
  console.log(`[${a.name}] matched → ${assign.matchId} ${assign.wsUrl}`);

  const transport = await connectWithRetry({
    wsUrl: assign.wsUrl,
    wtUrl: a.forceWs ? undefined : assign.wtUrl,
    certHash: assign.certHash ? hexToBytes(assign.certHash) : undefined,
    forceWs: a.forceWs,
  });

  const args: Args = {
    name: a.name,
    url: assign.wsUrl,
    wtUrl: assign.wtUrl,
    certHashHex: assign.certHash,
    forceWs: a.forceWs,
    durationMs: a.durationMs, // long; the client exits when the match ends (server closes)
    dir: a.dir,
    latMs: 0,
    jitterMs: 0,
    dropProb: 0,
    fire: a.fire,
    fireIntervalMs: 450,
  };
  new GameClient(args, transport).start();
}

main().catch((err) => {
  console.error("[mm-client] fatal:", err);
  process.exit(1);
});
