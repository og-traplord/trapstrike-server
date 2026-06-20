// Client-side transport abstraction. The GameClient talks only to this interface,
// so swapping WebSocket ↔ WebTransport is invisible to prediction/interp/combat.
//   sendUnreliable → InputCmd        (WS binary / WT datagram)
//   onUnreliable   → Snapshots       (WS binary 0x02 / WT datagram)
//   onReliable     → Events          (WS binary 0x03 / WT reliable stream)
//   onControl      → Welcome JSON     (WS text / WT reliable stream tag 0x11)
//
// Each channel buffers anything that arrives before its callback is registered
// (the server sends `welcome` the instant we connect, before GameClient wires up).

import { WebTransport, quicheLoaded } from "@fails-components/webtransport";
import { WebSocket } from "ws";

const SNAPSHOT = 0x02;
const EVENT = 0x03;
const CONTROL_TAG = 0x11;

export interface ClientTransport {
  readonly kind: "ws" | "wt";
  sendUnreliable(data: Uint8Array): void;
  onUnreliable(cb: (data: Uint8Array) => void): void;
  onReliable(cb: (data: Uint8Array) => void): void;
  onControl(cb: (msg: unknown) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

/** Holds the three inbound callbacks and buffers pre-registration messages. */
class Inbox {
  private ctrl?: (m: unknown) => void;
  private unrel?: (d: Uint8Array) => void;
  private rel?: (d: Uint8Array) => void;
  private pCtrl: unknown[] = [];
  private pUnrel: Uint8Array[] = [];
  private pRel: Uint8Array[] = [];

  routeControl(m: unknown): void {
    if (this.ctrl) this.ctrl(m);
    else this.pCtrl.push(m);
  }
  routeUnreliable(d: Uint8Array): void {
    if (this.unrel) this.unrel(d);
    else this.pUnrel.push(d);
  }
  routeReliable(d: Uint8Array): void {
    if (this.rel) this.rel(d);
    else this.pRel.push(d);
  }
  setControl(cb: (m: unknown) => void): void {
    this.ctrl = cb;
    const q = this.pCtrl;
    this.pCtrl = [];
    for (const m of q) cb(m);
  }
  setUnreliable(cb: (d: Uint8Array) => void): void {
    this.unrel = cb;
    const q = this.pUnrel;
    this.pUnrel = [];
    for (const d of q) cb(d);
  }
  setReliable(cb: (d: Uint8Array) => void): void {
    this.rel = cb;
    const q = this.pRel;
    this.pRel = [];
    for (const d of q) cb(d);
  }
}

// --- WebSocket ---

export class WsClientTransport implements ClientTransport {
  readonly kind = "ws" as const;
  private readonly ws: WebSocket;
  private readonly inbox = new Inbox();
  private closeCb?: () => void;

  constructor(private readonly url: string) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = "nodebuffer";
    this.ws.on("message", (raw, isBinary) => this.onMessage(raw as Buffer, isBinary));
    this.ws.on("close", () => this.closeCb?.());
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === this.ws.OPEN) return resolve();
      const to = setTimeout(() => reject(new Error("ws connect timeout")), 4000);
      this.ws.once("open", () => {
        clearTimeout(to);
        resolve();
      });
      this.ws.once("error", (err) => {
        clearTimeout(to);
        reject(err);
      });
    });
  }

  private onMessage(data: Buffer, isBinary: boolean): void {
    if (!isBinary) {
      try {
        this.inbox.routeControl(JSON.parse(data.toString("utf8")));
      } catch {
        /* ignore */
      }
      return;
    }
    if (data.length === 0) return;
    if (data[0] === SNAPSHOT) this.inbox.routeUnreliable(data);
    else if (data[0] === EVENT) this.inbox.routeReliable(data);
  }

  sendUnreliable(data: Uint8Array): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(data, { binary: true });
  }
  onUnreliable(cb: (d: Uint8Array) => void): void {
    this.inbox.setUnreliable(cb);
  }
  onReliable(cb: (d: Uint8Array) => void): void {
    this.inbox.setReliable(cb);
  }
  onControl(cb: (m: unknown) => void): void {
    this.inbox.setControl(cb);
  }
  onClose(cb: () => void): void {
    this.closeCb = cb;
  }
  close(): void {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

// --- WebTransport ---

export class WtClientTransport implements ClientTransport {
  readonly kind = "wt" as const;
  private wt?: WebTransport;
  private readonly inbox = new Inbox();
  private datagramWriter?: WritableStreamDefaultWriter<Uint8Array>;
  private closeCb?: () => void;
  private closed = false;

  constructor(
    private readonly url: string,
    private readonly certHash: Uint8Array,
  ) {}

  async connect(): Promise<void> {
    // The native QUIC lib loads asynchronously; it must be ready before we
    // construct the client (otherwise it throws "loading attempt did not end").
    await quicheLoaded;
    const wt = new WebTransport(this.url, {
      serverCertificateHashes: [{ algorithm: "sha-256", value: this.certHash }],
    });
    this.wt = wt;
    await wt.ready;
    this.datagramWriter = wt.datagrams.createWritable().getWriter();
    void this.readDatagrams();
    void this.readReliable();
    wt.closed.then(() => this.handleClose()).catch(() => this.handleClose());
  }

  private async readDatagrams(): Promise<void> {
    try {
      const reader = this.wt!.datagrams.readable.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) this.inbox.routeUnreliable(value as Uint8Array);
      }
    } catch {
      /* ignore */
    }
    this.handleClose();
  }

  private async readReliable(): Promise<void> {
    try {
      const sreader = this.wt!.incomingUnidirectionalStreams.getReader();
      const { value: stream, done } = await sreader.read();
      if (done || !stream) return;
      await this.pump((stream as ReadableStream<Uint8Array>).getReader());
    } catch {
      /* ignore */
    }
  }

  private async pump(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    let buf = new Uint8Array(0);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        const next = new Uint8Array(buf.length + value.length);
        next.set(buf);
        next.set(value, buf.length);
        buf = next;
      }
      for (;;) {
        if (buf.length < 4) break;
        const len = (buf[0]! | (buf[1]! << 8) | (buf[2]! << 16) | (buf[3]! << 24)) >>> 0;
        if (buf.length < 4 + len) break;
        const payload = buf.slice(4, 4 + len);
        buf = buf.slice(4 + len);
        if (payload[0] === CONTROL_TAG) {
          try {
            this.inbox.routeControl(JSON.parse(Buffer.from(payload.subarray(1)).toString("utf8")));
          } catch {
            /* ignore */
          }
        } else {
          this.inbox.routeReliable(payload);
        }
      }
    }
  }

  sendUnreliable(data: Uint8Array): void {
    if (this.closed || !this.datagramWriter) return;
    this.datagramWriter.write(data).catch(() => {});
  }
  onUnreliable(cb: (d: Uint8Array) => void): void {
    this.inbox.setUnreliable(cb);
  }
  onReliable(cb: (d: Uint8Array) => void): void {
    this.inbox.setReliable(cb);
  }
  onControl(cb: (m: unknown) => void): void {
    this.inbox.setControl(cb);
  }
  onClose(cb: () => void): void {
    this.closeCb = cb;
  }
  close(): void {
    this.handleClose();
    try {
      this.wt?.close();
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

// --- Connect with WebTransport-first, WebSocket fallback ---

export interface ConnectOptions {
  wsUrl: string;
  wtUrl?: string;
  certHash?: Uint8Array;
  forceWs?: boolean;
  wtTimeoutMs?: number;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)),
  ]);
}

export async function connectWithFallback(o: ConnectOptions): Promise<ClientTransport> {
  if (!o.forceWs && o.wtUrl && o.certHash) {
    try {
      const wt = new WtClientTransport(o.wtUrl, o.certHash);
      await withTimeout(wt.connect(), o.wtTimeoutMs ?? 3000);
      return wt;
    } catch (err) {
      console.log(
        `[transport] WebTransport unavailable (${(err as Error).message}); falling back to WebSocket`,
      );
    }
  }
  const ws = new WsClientTransport(o.wsUrl);
  await ws.connect();
  return ws;
}
