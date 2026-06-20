import type { PlayerInput } from "@trapstrike/shared";

const SEQ_MOD = 0x10000;

/** True if u16 `a` is newer than `b`, accounting for wrap-around. */
export function seqGreaterThan(a: number, b: number): boolean {
  const d = (a - b + SEQ_MOD) % SEQ_MOD;
  return d !== 0 && d < 0x8000;
}

/**
 * Per-player buffer that absorbs network jitter: inputs may arrive out of order
 * or bunched up, but the sim consumes exactly one per tick in seq order. Stale or
 * duplicate inputs are dropped. `lastProcessedSeq` becomes the snapshot ackSeq.
 */
export class JitterBuffer {
  private pending: PlayerInput[] = [];
  lastProcessedSeq = -1; // -1 → nothing processed yet

  push(cmd: PlayerInput): void {
    if (this.lastProcessedSeq >= 0 && !seqGreaterThan(cmd.seq, this.lastProcessedSeq)) return;
    for (const p of this.pending) if (p.seq === cmd.seq) return; // dedupe
    this.pending.push(cmd);
  }

  /** Next unprocessed input in seq order, or null if starved. */
  popNext(): PlayerInput | null {
    if (this.pending.length === 0) return null;
    let bestIdx = 0;
    for (let i = 1; i < this.pending.length; i++) {
      if (seqGreaterThan(this.pending[bestIdx].seq, this.pending[i].seq)) bestIdx = i;
    }
    const [cmd] = this.pending.splice(bestIdx, 1);
    this.lastProcessedSeq = cmd!.seq;
    return cmd!;
  }

  get size(): number {
    return this.pending.length;
  }
}
