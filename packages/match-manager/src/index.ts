import { MatchManager, type ManagerConfig } from "./manager";
import { createQueueStore } from "./queue-store";

const cfg: ManagerConfig = {
  host: process.env.MM_HOST ?? "0.0.0.0",
  port: Number(process.env.MM_PORT ?? 9000),
  publicHost: process.env.PUBLIC_HOST ?? "127.0.0.1",
  portBase: Number(process.env.PORT_BASE ?? 8100),
  portCount: Number(process.env.PORT_COUNT ?? 50),
  matchSize: Number(process.env.MATCH_SIZE ?? 10),
  enableWt: process.env.MM_ENABLE_WT === "1",
  rounds: Number(process.env.ROUNDS ?? 3),
  roundMs: Number(process.env.ROUND_MS ?? 8_000),
  warmupMs: Number(process.env.WARMUP_MS ?? 10_000),
  intermissionMs: Number(process.env.INTERMISSION_MS ?? 1_500),
  minPlayers: Number(process.env.MIN_PLAYERS ?? 2),
};

const queue = await createQueueStore(process.env.REDIS_URL);
const manager = new MatchManager(cfg, queue);
await manager.start();

const shutdown = async (): Promise<void> => {
  console.log("\n[mm] shutting down");
  await manager.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
