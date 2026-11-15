// Small key-value layer: Upstash Redis when configured, otherwise an in-memory map
// for local development. Values are JSON.

import { Redis } from "@upstash/redis";

export interface KV {
  get<T>(key: string): Promise<T | null>;
  /** Returns false when `nx` is set and the key already exists. */
  set(key: string, value: unknown, opts?: { ex?: number; nx?: boolean }): Promise<boolean>;
  del(key: string): Promise<void>;
  /** Atomically read and delete (single-use records). */
  take<T>(key: string): Promise<T | null>;
  /** Increment a counter, setting its expiry on first use. */
  incr(key: string, ex: number): Promise<number>;
}

function redisUrlAndToken() {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  return url && token ? { url, token } : null;
}

export const hasRedis = () => !!redisUrlAndToken();

function redisKV(url: string, token: string): KV {
  const r = new Redis({ url, token, automaticDeserialization: true });
  return {
    get: (k) => r.get(k),
    async set(k, v, o = {}) {
      const res = o.ex
        ? o.nx
          ? await r.set(k, v, { ex: o.ex, nx: true })
          : await r.set(k, v, { ex: o.ex })
        : o.nx
          ? await r.set(k, v, { nx: true })
          : await r.set(k, v);
      return res === "OK";
    },
    del: async (k) => void (await r.del(k)),
    take: (k) => r.getdel(k),
    async incr(k, ex) {
      const n = await r.incr(k);
      if (n === 1) await r.expire(k, ex);
      return n;
    },
  };
}

type Entry = { v: string; exp: number };
const g = globalThis as unknown as { __epsonMemKV?: Map<string, Entry> };

function memoryKV(): KV {
  const m = (g.__epsonMemKV ??= new Map());
  const live = (k: string) => {
    const e = m.get(k);
    if (e && e.exp && e.exp < Date.now()) m.delete(k);
    return m.get(k);
  };
  return {
    async get<T>(k: string) {
      const e = live(k);
      return e ? (JSON.parse(e.v) as T) : null;
    },
    async set(k, v, o = {}) {
      if (o.nx && live(k)) return false;
      m.set(k, { v: JSON.stringify(v), exp: o.ex ? Date.now() + o.ex * 1000 : 0 });
      return true;
    },
    async del(k) {
      m.delete(k);
    },
    async take<T>(k: string) {
      const e = live(k);
      m.delete(k);
      return e ? (JSON.parse(e.v) as T) : null;
    },
    async incr(k, ex) {
      const e = live(k);
      const n = (e ? Number(JSON.parse(e.v)) : 0) + 1;
      m.set(k, { v: JSON.stringify(n), exp: e?.exp || Date.now() + ex * 1000 });
      return n;
    },
  };
}

let cached: KV | null = null;

export function kv(): KV {
  if (cached) return cached;
  const r = redisUrlAndToken();
  if (r) return (cached = redisKV(r.url, r.token));
  // On Vercel, function instances don't share memory, so a memory store would lose
  // sign-ins between requests. Refuse rather than fail confusingly.
  if (process.env.VERCEL && process.env.MCP_ALLOW_MEMORY_STORE !== "true") {
    throw new Error("Redis is not configured (UPSTASH_REDIS_REST_URL / KV_REST_API_URL). Connect Upstash Redis to this Vercel project.");
  }
  return (cached = memoryKV());
}
