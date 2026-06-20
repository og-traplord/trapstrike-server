// The single seam between gameplay and the wire. M1 ships a WebSocket impl; M5
// drops in WebTransport behind this exact interface with no game-logic changes.

export interface TransportConnection {
  readonly id: number;
  /** Which transport this client arrived on — informational (logging/metrics). */
  readonly kind: "ws" | "wt";
  /** State that may be dropped/superseded — snapshots. (M5: WebTransport datagrams.) */
  sendUnreliable(data: Uint8Array): void;
  /** Must-not-drop, ordered — events (hit/kill). (M5: WebTransport reliable stream.) */
  sendReliable(data: Uint8Array): void;
  /** JSON control frame — handshake / lobby only, never gameplay (Law 3). */
  sendControl(msg: object): void;
  /** Inbound binary game packets from this client. */
  onMessage(cb: (data: Uint8Array) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

export interface Transport {
  start(): Promise<void>;
  stop(): Promise<void>;
  onConnection(cb: (conn: TransportConnection) => void): void;
}
