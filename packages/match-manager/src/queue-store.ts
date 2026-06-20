// Matchmaking queue + assignment store. Redis-backed in production (docker-compose),
// with an in-memory impl for local/headless runs (no Redis dependency).

export interface Assignment {
  matchId: string;
  host: string;
  port: number;
  wsUrl: string;
  wtUrl: string;
  certHash?: string;
}

export type TicketStatus =
  | { state: "queued" }
  | { state: "matched"; assignment: Assignment }
  | { state: "unknown" };

export interface QueueStore {
  enqueue(ticket: string): Promise<void>;
  queueLength(): Promise<number>;
  /** Atomically remove up to `n` tickets from the front of the queue. */
  popBatch(n: number): Promise<string[]>;
  setAssignment(ticket: string, a: Assignment): Promise<void>;
  getStatus(ticket: string): Promise<TicketStatus>;
  close(): Promise<void>;
}

export class InMemoryQueueStore implements QueueStore {
  private q: string[] = [];
  private queued = new Set<string>();
  private assignments = new Map<string, Assignment>();

  async enqueue(t: string): Promise<void> {
    this.q.push(t);
    this.queued.add(t);
  }
  async queueLength(): Promise<number> {
    return this.q.length;
  }
  async popBatch(n: number): Promise<string[]> {
    const batch = this.q.splice(0, n);
    for (const t of batch) this.queued.delete(t);
    return batch;
  }
  async setAssignment(t: string, a: Assignment): Promise<void> {
    this.assignments.set(t, a);
  }
  async getStatus(t: string): Promise<TicketStatus> {
    const a = this.assignments.get(t);
    if (a) return { state: "matched", assignment: a };
    return this.queued.has(t) ? { state: "queued" } : { state: "unknown" };
  }
  async close(): Promise<void> {}
}

const QKEY = "mm:queue";
const SKEY = "mm:queued";
const akey = (t: string): string => `mm:assign:${t}`;

class RedisQueueStore implements QueueStore {
  // ioredis is typed loosely here so it stays a lazy/optional dependency.
  constructor(private readonly redis: any) {}

  async enqueue(t: string): Promise<void> {
    await this.redis.multi().rpush(QKEY, t).sadd(SKEY, t).exec();
  }
  async queueLength(): Promise<number> {
    return this.redis.llen(QKEY);
  }
  async popBatch(n: number): Promise<string[]> {
    const items: string[] | null = await this.redis.lpop(QKEY, n);
    if (!items || items.length === 0) return [];
    await this.redis.srem(SKEY, ...items);
    return items;
  }
  async setAssignment(t: string, a: Assignment): Promise<void> {
    await this.redis.set(akey(t), JSON.stringify(a), "EX", 300);
  }
  async getStatus(t: string): Promise<TicketStatus> {
    const a = await this.redis.get(akey(t));
    if (a) return { state: "matched", assignment: JSON.parse(a) as Assignment };
    const inQueue = await this.redis.sismember(SKEY, t);
    return inQueue ? { state: "queued" } : { state: "unknown" };
  }
  async close(): Promise<void> {
    this.redis.disconnect();
  }
}

/** Redis when REDIS_URL is set, else in-memory. */
export async function createQueueStore(redisUrl?: string): Promise<QueueStore> {
  if (!redisUrl) {
    console.log("[mm] queue store: in-memory (set REDIS_URL for Redis)");
    return new InMemoryQueueStore();
  }
  const mod: any = await import("ioredis");
  const Redis = mod.default ?? mod;
  console.log(`[mm] queue store: Redis ${redisUrl}`);
  return new RedisQueueStore(new Redis(redisUrl));
}
