// Minimal little-endian binary cursor. The whole gameplay hot path rides on this;
// no JSON below the handshake.

export class ByteWriter {
  private buf: Uint8Array;
  private view: DataView;
  off = 0;

  constructor(size = 256) {
    this.buf = new Uint8Array(size);
    this.view = new DataView(this.buf.buffer);
  }

  private ensure(n: number): void {
    const need = this.off + n;
    if (need <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf);
    this.buf = next;
    this.view = new DataView(this.buf.buffer);
  }

  u8(v: number): this {
    this.ensure(1);
    this.view.setUint8(this.off, v & 0xff);
    this.off += 1;
    return this;
  }
  i8(v: number): this {
    this.ensure(1);
    this.view.setInt8(this.off, v);
    this.off += 1;
    return this;
  }
  u16(v: number): this {
    this.ensure(2);
    this.view.setUint16(this.off, v & 0xffff, true);
    this.off += 2;
    return this;
  }
  i16(v: number): this {
    this.ensure(2);
    this.view.setInt16(this.off, v, true);
    this.off += 2;
    return this;
  }
  u32(v: number): this {
    this.ensure(4);
    this.view.setUint32(this.off, v >>> 0, true);
    this.off += 4;
    return this;
  }

  /** Rewind to empty for reuse (avoids per-snapshot allocation in the hot path). */
  reset(): this {
    this.off = 0;
    return this;
  }

  /** A copy sized exactly to the written bytes — safe to hand to a socket. */
  bytes(): Uint8Array {
    return this.buf.slice(0, this.off);
  }
}

export class ByteReader {
  private view: DataView;
  off = 0;

  constructor(buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  u8(): number {
    const v = this.view.getUint8(this.off);
    this.off += 1;
    return v;
  }
  i8(): number {
    const v = this.view.getInt8(this.off);
    this.off += 1;
    return v;
  }
  u16(): number {
    const v = this.view.getUint16(this.off, true);
    this.off += 2;
    return v;
  }
  i16(): number {
    const v = this.view.getInt16(this.off, true);
    this.off += 2;
    return v;
  }
  u32(): number {
    const v = this.view.getUint32(this.off, true);
    this.off += 4;
    return v;
  }

  get remaining(): number {
    return this.view.byteLength - this.off;
  }
}
