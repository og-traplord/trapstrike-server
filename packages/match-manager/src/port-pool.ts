/** Fixed pool of ports for spawned game-server processes. One port = one match. */
export class PortPool {
  private free: number[];
  private readonly used = new Set<number>();

  constructor(base: number, count: number) {
    this.free = Array.from({ length: count }, (_, i) => base + i);
  }

  alloc(): number | null {
    const p = this.free.shift();
    if (p === undefined) return null;
    this.used.add(p);
    return p;
  }

  release(port: number): void {
    if (this.used.delete(port)) this.free.push(port);
  }

  get available(): number {
    return this.free.length;
  }
}
