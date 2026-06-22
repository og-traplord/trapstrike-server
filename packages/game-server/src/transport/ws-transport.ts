import { type WebSocket, WebSocketServer } from "ws";
import type { Transport, TransportConnection } from "./types";

export interface WsTransportOptions {
  port: number;
  host?: string;
  /** Optional shared connection-id source (so WS + WT ids don't collide). */
  allocId?: () => number;
}

export class WsTransport implements Transport {
  private wss?: WebSocketServer;
  private connectionCb?: (conn: TransportConnection) => void;
  private nextId = 1;
  private readonly allocId: () => number;

  constructor(private readonly opts: WsTransportOptions) {
    this.allocId = opts.allocId ?? (() => this.nextId++);
  }

  onConnection(cb: (conn: TransportConnection) => void): void {
    this.connectionCb = cb;
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.wss = new WebSocketServer({ port: this.opts.port, host: this.opts.host });
      this.wss.on("connection", (ws, request) => {
        // Room/passcode from the connect URL: wss://host/?room=ABC
        let room: string | undefined;
        try {
          const q = (request.url ?? "").split("?")[1] ?? "";
          room = new URLSearchParams(q).get("room") ?? undefined;
        } catch {
          /* no room → default */
        }
        this.connectionCb?.(new WsConnection(this.allocId(), ws, room));
      });
      this.wss.on("listening", () => resolve());
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
    });
  }
}

class WsConnection implements TransportConnection {
  readonly kind = "ws" as const;
  private msgCb?: (data: Uint8Array) => void;
  private ctrlCb?: (msg: unknown) => void;
  private closeCb?: () => void;

  constructor(
    public readonly id: number,
    private readonly ws: WebSocket,
    public readonly room?: string,
  ) {
    ws.binaryType = "nodebuffer";
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        this.msgCb?.(data as Buffer);
      } else {
        // text frame = JSON lobby control (team/ready/start)
        try {
          this.ctrlCb?.(JSON.parse(data.toString()));
        } catch {
          /* ignore malformed control */
        }
      }
    });
    ws.on("close", () => this.closeCb?.());
    ws.on("error", () => {
      /* errors surface as a subsequent 'close' */
    });
  }

  // Over a single WebSocket (TCP) both channels are reliable + ordered. The split
  // is what lets M5 route unreliable→datagrams and reliable→stream with no
  // game-logic change.
  sendUnreliable(data: Uint8Array): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(data, { binary: true });
  }

  sendReliable(data: Uint8Array): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(data, { binary: true });
  }

  sendControl(msg: object): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg));
  }

  onMessage(cb: (data: Uint8Array) => void): void {
    this.msgCb = cb;
  }

  onControl(cb: (msg: unknown) => void): void {
    this.ctrlCb = cb;
  }

  onClose(cb: () => void): void {
    this.closeCb = cb;
  }

  close(): void {
    this.ws.close();
  }
}
