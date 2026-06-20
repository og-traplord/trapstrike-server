// One-command demo: spawn the server (WS + WebTransport), then two clients.
//   LAT/JITTER/DROP — simulated network   FIRE=1 — M4 combat   FORCE_WS=1 — fallback
// By default clients try WebTransport first (reading the server's dev-cert hash)
// and fall back to WebSocket.

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const tsx = resolve(root, "node_modules/.bin/tsx");
const PORT = "8090";
const DURATION = "5000";

const LAT = process.env.LAT ?? "0";
const JITTER = process.env.JITTER ?? "0";
const DROP = process.env.DROP ?? "0";
const FIRE = process.env.FIRE === "1";
const FORCE_WS = process.env.FORCE_WS === "1";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function spawnServer(): ChildProcess {
  return spawn(tsx, [resolve(root, "packages/game-server/src/index.ts")], {
    stdio: "inherit",
    cwd: root,
    env: { ...process.env, PORT, HOST: "127.0.0.1" },
  });
}

function readCertHash(): string | undefined {
  const p = resolve(root, ".wt-dev-cert/hash.txt");
  return existsSync(p) ? readFileSync(p, "utf8").trim() : undefined;
}

function spawnClient(name: string, dir: string, certHash?: string): ChildProcess {
  const argv = [
    resolve(here, "index.ts"),
    "--name", name,
    "--dir", dir,
    "--url", `ws://127.0.0.1:${PORT}`,
    "--duration", DURATION,
    "--lat", LAT,
    "--jitter", JITTER,
    "--drop", DROP,
  ];
  if (FORCE_WS) {
    argv.push("--force-ws");
  } else if (certHash) {
    argv.push("--wt-url", `https://127.0.0.1:${PORT}/play`, "--cert-hash", certHash);
  }
  if (FIRE) argv.push("--fire");
  return spawn(tsx, argv, { stdio: "inherit", cwd: root });
}

async function main(): Promise<void> {
  console.log("[demo] starting server (WS + WebTransport)…");
  const server = spawnServer();
  await delay(2500); // bind + cert gen + QUIC start

  const certHash = FORCE_WS ? undefined : readCertHash();
  console.log(
    `[demo] two clients (A +X, B +Z)  transport=${FORCE_WS ? "WS (forced)" : certHash ? "WT→WS fallback" : "WS"}  lat=${LAT}ms jitter=${JITTER}ms drop=${DROP} fire=${FIRE}\n`,
  );
  const a = spawnClient("A", "x", certHash);
  const b = spawnClient("B", "z", certHash);

  let exited = 0;
  const onExit = (): void => {
    if (++exited === 2) {
      console.log("\n[demo] both clients finished — stopping server");
      server.kill("SIGINT");
      setTimeout(() => process.exit(0), 400);
    }
  };
  a.on("exit", onExit);
  b.on("exit", onExit);
}

main().catch((err) => {
  console.error("[demo] fatal:", err);
  process.exit(1);
});
