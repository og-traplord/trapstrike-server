import { performance } from "node:perf_hooks";
import { SNAPSHOT_DT_MS, TICK_DT_MS, TICK_DT_S, TICK_HZ } from "@trapstrike/shared";
import { Room } from "./room";
import { MatchLifecycle } from "./lifecycle";
import type { Transport, TransportConnection } from "./transport/types";
import { WsTransport } from "./transport/ws-transport";
// WebTransport (native QUIC) is imported LAZILY inside main() only when WT is
// enabled, so a WebSocket-only deploy (e.g. Render with WT=0) never loads or builds
// the native @fails-components/webtransport module.

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "0.0.0.0";
const WT_ENABLED = process.env.WT !== "0";
const MAX_CATCHUP_STEPS = 5;

// Match lifecycle (M6) — only when the match-manager sets LIFECYCLE=1.
const LIFECYCLE = process.env.LIFECYCLE === "1";
const MATCH_ID = process.env.MATCH_ID ?? "local";
const EXPECTED_PLAYERS = Number(process.env.EXPECTED_PLAYERS ?? 10);
const MIN_PLAYERS = Number(process.env.MIN_PLAYERS ?? 2);
const WARMUP_MS = Number(process.env.WARMUP_MS ?? 10_000);
const ROUNDS = Number(process.env.ROUNDS ?? 3);
const ROUND_MS = Number(process.env.ROUND_MS ?? 8_000);
const INTERMISSION_MS = Number(process.env.INTERMISSION_MS ?? 1_500);
const HARD_TIMEOUT_MS = Number(process.env.HARD_TIMEOUT_MS ?? 30_000);

const DEFAULT_ROOM = "MAIN";
function sanitizeRoom(code?: string): string {
  const c = (code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
  return c || DEFAULT_ROOM;
}

async function main(): Promise<void> {
  // One server hosts many independent rooms keyed by passcode. Each Room is a
  // lobby→match state machine; same `?room=CODE` = same room, different = isolated.
  const rooms = new Map<string, Room>();
  const getRoom = (code: string): Room => {
    let r = rooms.get(code);
    if (!r) {
      r = new Room(code);
      rooms.set(code, r);
      console.log(`[server] room created: ${code} (rooms=${rooms.size})`);
    }
    return r;
  };
  let nextConnId = 1;
  const allocId = (): number => nextConnId++;

  const wire = (conn: TransportConnection): void => {
    const code = sanitizeRoom(conn.room);
    getRoom(code).addConn(conn); // Room owns onMessage/onControl/onClose for this connection
  };

  const transports: Transport[] = [];

  // WebSocket (always on) — the reliable baseline / fallback.
  const ws = new WsTransport({ port: PORT, host: HOST, allocId });
  ws.onConnection(wire);
  await ws.start();
  transports.push(ws);

  // WebTransport (QUIC) — primary when the client supports it. Same Match, same
  // game logic; only the wire differs.
  let wtUp = false;
  if (WT_ENABLED) {
    try {
      // Lazy import — only reached when WT!=0, so WS-only hosts never touch native QUIC.
      const [{ WT_PATH, WtTransport }, { getDevCert }] = await Promise.all([
        import("./transport/wt-transport"),
        import("./transport/dev-cert"),
      ]);
      const cert = getDevCert();
      const wt = new WtTransport({
        port: PORT,
        host: HOST,
        cert: cert.cert,
        privKey: cert.privKey,
        allocId,
      });
      wt.onConnection(wire);
      await wt.start();
      transports.push(wt);
      wtUp = true;
      console.log(
        `[server] WebTransport up: https://${HOST}:${PORT}${WT_PATH}  certHash=${cert.hashHex.slice(0, 16)}…`,
      );
    } catch (err) {
      console.warn(`[server] WebTransport disabled: ${(err as Error).message}`);
    }
  }

  console.log(
    `[server] listening ws://${HOST}:${PORT}${wtUp ? " (+ WebTransport)" : ""}  tick=${TICK_HZ}Hz`,
  );

  // --- Fixed-step authoritative loop (unchanged) ---
  let tick = 0;
  let acc = 0;
  let snapAcc = 0;
  let last = performance.now();
  let lastLog = last;
  let ticksThisWindow = 0;

  const frame = (): void => {
    const now = performance.now();
    let elapsed = now - last;
    last = now;
    if (elapsed > 250) elapsed = 250;
    acc += elapsed;

    let steps = 0;
    while (acc >= TICK_DT_MS && steps < MAX_CATCHUP_STEPS) {
      for (const m of rooms.values()) m.step(TICK_DT_S, tick);
      ticksThisWindow++;
      acc -= TICK_DT_MS;
      steps++;
      snapAcc += TICK_DT_MS;
      if (snapAcc >= SNAPSHOT_DT_MS) {
        snapAcc -= SNAPSHOT_DT_MS;
        for (const m of rooms.values()) m.broadcastSnapshots(tick);
      }
      tick++;
    }
    if (steps === MAX_CATCHUP_STEPS && acc > TICK_DT_MS) acc = 0;

    if (now - lastLog >= 1000) {
      const hz = (ticksThisWindow * 1000) / (now - lastLog);
      let players = 0;
      for (const [code, r] of rooms) {
        players += r.playerCount;
        if (r.playerCount === 0 && code !== DEFAULT_ROOM) rooms.delete(code); // reap empties
      }
      console.log(`[server] tick=${tick} rate=${hz.toFixed(1)}Hz rooms=${rooms.size} players=${players}`);
      ticksThisWindow = 0;
      lastLog = now;
    }
    setTimeout(frame, Math.max(0, TICK_DT_MS - acc));
  };
  frame();

  const shutdown = async (): Promise<void> => {
    await Promise.all(transports.map((t) => t.stop()));
    process.exit(0);
  };
  process.on("SIGINT", () => {
    console.log("\n[server] shutting down");
    void shutdown();
  });
  process.on("SIGTERM", () => void shutdown());

  // Run the WARMUP→LIVE→END lifecycle; on END the process exits so the
  // match-manager reaps it and frees the port (TEARDOWN).
  if (LIFECYCLE) {
    new MatchLifecycle(
      getRoom(DEFAULT_ROOM).startEmptyMatch(),
      {
        matchId: MATCH_ID,
        expectedPlayers: EXPECTED_PLAYERS,
        minPlayers: MIN_PLAYERS,
        warmupMs: WARMUP_MS,
        rounds: ROUNDS,
        roundMs: ROUND_MS,
        intermissionMs: INTERMISSION_MS,
        hardTimeoutMs: HARD_TIMEOUT_MS,
      },
      () => {
        console.log(`[server] match ${MATCH_ID} complete — exiting`);
        void shutdown();
      },
      (m) => console.log(`[server] ${m}`),
    ).start();
  }
}

main().catch((err) => {
  console.error("[server] fatal:", err);
  process.exit(1);
});
