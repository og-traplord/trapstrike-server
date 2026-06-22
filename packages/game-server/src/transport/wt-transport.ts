// WebTransport server transport (M5). Maps the same Transport interface onto QUIC:
//   sendUnreliable → datagrams        (snapshots — droppable)
//   sendReliable   → unidirectional stream, length-framed   (events — ordered)
//   sendControl    → same reliable stream, tagged 0x11      (welcome JSON)
//   inbound        → client datagrams  (InputCmd)
// No game-logic change: Match still just calls send{Unreliable,Reliable,Control}.

import { Http3Server, type WebTransportSession } from "@fails-components/webtransport";
import type { Transport, TransportConnection } from "./types";

export const WT_PATH = "/play";
const CONTROL_TAG = 0x11; // PROTOCOL.md Welcome tag, on the reliable stream

export interface WtTransportOptions {
  port: number;
  host: string;
  cert: string;
  privKey: string;
  secret?: string;
  path?: string;
  allocId: () => number;
}

export class WtTransport implements Transport {
  private server?: Http3Server;
  private connectionCb?: (conn: TransportConnection) => void;
  private running = false;

  constructor(private readonly opts: WtTransportOptions) {}

  onConnection(cb: (conn: TransportConnection) => void): void {
    this.connectionCb = cb;
  }

  async start(): Promise<void> {
    this.server = new Http3Server({
      port: this.opts.port,
      host: this.opts.host,
      secret: this.opts.secret ?? "trapstrike-dev",
      cert: this.opts.cert,
      privKey: this.opts.privKey,
      defaultDatagramsReadableMode: "bytes",
    });
    this.server.startServer();
    await this.server.ready;
    this.running = true;
    void this.acceptLoop(this.opts.path ?? WT_PATH);
  }

  private async acceptLoop(path: string): Promise<void> {
    const reader = this.server!.sessionStream(path).getReader();
    while (this.running) {
      const { done, value: session } = await reader.read();
      if (done) break;
      if (!session) continue;
      const conn = new WtConnection(this.opts.allocId(), session);
      this.connectionCb?.(conn);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    try {
      this.server?.stopServer();
    } catch {
      /* ignore */
    }
  }
}

class WtConnection implements TransportConnection {
  readonly kind = "wt" as const;
  private msgCb?: (data: Uint8Array) => void;
  private closeCb?: () => void;
  private datagramWriter?: WritableStreamDefaultWriter<Uint8Array>;
  private reliableWriter?: WritableStreamDefaultWriter<Uint8Array>;
  private reliableQueue: Uint8Array[] = [];
  private reliableReady = false;
  private closed = false;

  constructor(
    public readonly id: number,
    private readonly session: WebTransportSession,
  ) {
    void this.setup();
  }

  private async setup(): Promise<void> {
    try {
      await this.session.ready;
      this.datagramWriter = this.session.datagrams.createWritable().getWriter();
      const stream = await this.session.createUnidirectionalStream();
      this.reliableWriter = stream.getWriter();
      this.reliableReady = true;
      for (const payload of this.reliableQueue) this.writeFramed(payload);
      this.reliableQueue.length = 0;

      void this.readDatagrams();
      this.session.closed.then(() => this.handleClose()).catch(() => this.handleClose());
    } catch {
      this.handleClose();
    }
  }

  private async readDatagrams(): Promise<void> {
    try {
      const reader = this.session.datagrams.readable.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && this.msgCb) this.msgCb(value as Uint8Array);
      }
    } catch {
      /* fallthrough to close */
    }
    this.handleClose();
  }

  private writeFramed(payload: Uint8Array): void {
    const buf = new Uint8Array(4 + payload.length);
    const n = payload.length;
    buf[0] = n & 0xff;
    buf[1] = (n >>> 8) & 0xff;
    buf[2] = (n >>> 16) & 0xff;
    buf[3] = (n >>> 24) & 0xff;
    buf.set(payload, 4);
    this.reliableWriter?.write(buf).catch(() => this.handleClose());
  }

  private enqueueReliable(payload: Uint8Array): void {
    if (this.closed) return;
    if (!this.reliableReady) this.reliableQueue.push(payload.slice());
    else this.writeFramed(payload);
  }

  sendUnreliable(data: Uint8Array): void {
    if (this.closed || !this.datagramWriter) return;
    this.datagramWriter.write(data).catch(() => {});
  }

  sendReliable(data: Uint8Array): void {
    this.enqueueReliable(data);
  }

  sendControl(msg: object): void {
    const json = Buffer.from(JSON.stringify(msg), "utf8");
    const payload = new Uint8Array(1 + json.length);
    payload[0] = CONTROL_TAG;
    payload.set(json, 1);
    this.enqueueReliable(payload);
  }

  onMessage(cb: (data: Uint8Array) => void): void {
    this.msgCb = cb;
  }
  onControl(_cb: (msg: unknown) => void): void {
    // Lobby control over WebTransport not wired (browser uses WS for lobby).
  }
  onClose(cb: () => void): void {
    this.closeCb = cb;
  }
  close(): void {
    this.handleClose();
    try {
      this.session.close();
    } catch {
      /* ignore */
    }
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCb?.();
  }
}
