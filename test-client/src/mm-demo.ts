// One-command M6 acceptance: start the match-manager, queue MATCH_SIZE clients,
// let them get matched into one spawned game-server process, play a full match,
// and confirm the process is reaped and its port freed.
//
// Run: pnpm demo:m6   (short rounds; uses the in-memory queue unless REDIS_URL set)

import { type ChildProcess, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const tsx = resolve(root, "node_modules/.bin/tsx");

const MM_PORT = process.env.MM_PORT ?? "9000";
const MATCH_SIZE = Number(process.env.MATCH_SIZE ?? 10);
const MANAGER = `http://127.0.0.1:${MM_PORT}`;

function spawnManager(): ChildProcess {
  return spawn(tsx, [resolve(root, "packages/match-manager/src/index.ts")], {
    stdio: "inherit",
    cwd: root,
    env: {
      ...process.env,
      MM_PORT,
      PUBLIC_HOST: "127.0.0.1",
      PORT_BASE: process.env.PORT_BASE ?? "8100",
      PORT_COUNT: process.env.PORT_COUNT ?? "20",
      MATCH_SIZE: String(MATCH_SIZE),
      MIN_PLAYERS: process.env.MIN_PLAYERS ?? "2",
      WARMUP_MS: process.env.WARMUP_MS ?? "5000",
      ROUNDS: process.env.ROUNDS ?? "2",
      ROUND_MS: process.env.ROUND_MS ?? "3500",
      INTERMISSION_MS: process.env.INTERMISSION_MS ?? "1200",
    },
  });
}

function spawnClient(name: string, dir: string): ChildProcess {
  return spawn(
    tsx,
    [resolve(here, "mm-client.ts"), "--name", name, "--manager", MANAGER, "--dir", dir, "--fire"],
    { stdio: "inherit", cwd: root },
  );
}

async function waitHealthy(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${MANAGER}/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error("manager never became healthy");
}

async function main(): Promise<void> {
  console.log("[mm-demo] starting match-manager…");
  const manager = spawnManager();
  await waitHealthy();
  console.log(`[mm-demo] manager healthy — queueing ${MATCH_SIZE} clients\n`);

  const clients: ChildProcess[] = [];
  for (let i = 0; i < MATCH_SIZE; i++) {
    clients.push(spawnClient(`P${i + 1}`, i % 2 === 0 ? "x" : "z"));
    await sleep(50);
  }

  let exited = 0;
  await new Promise<void>((res) => {
    for (const c of clients) c.on("exit", () => ++exited === MATCH_SIZE && res());
  });

  await sleep(900); // let the manager observe the game-server exit + reap
  const health = (await (await fetch(`${MANAGER}/health`)).json()) as {
    activeMatches: number;
    freePorts: number;
  };
  console.log(
    `\n[mm-demo] all ${MATCH_SIZE} clients finished. manager: activeMatches=${health.activeMatches} freePorts=${health.freePorts}`,
  );
  console.log(
    health.activeMatches === 0
      ? "[mm-demo] ✓ match played in a spawned process, then reaped & port freed"
      : "[mm-demo] ✗ a match process is still active",
  );

  manager.kill("SIGINT");
  setTimeout(() => process.exit(0), 500);
}

main().catch((err) => {
  console.error("[mm-demo] fatal:", err);
  process.exit(1);
});
