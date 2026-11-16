// Usage analytics for the remote MCP server: daily counters, per-connection stats,
// daily active connections and a short feed of recent events. Stored in the same
// Upstash Redis as the OAuth records (in memory for local development).
//
// Privacy: no document content, titles, printer serial numbers or tokens are stored.
// Connections are identified by their internal id; the dashboard shows a short tag.

import { Redis } from "@upstash/redis";

export type UsageEvent = {
  type: "client_registered" | "connected" | "connect_failed" | "session" | "tool" | "rate_limited" | "invalid_token";
  /** Printer connection id (full; the dashboard shows the first 6 characters). */
  conn?: string;
  /** AI app: DCR client_name, or clientInfo.name from MCP initialize. */
  app?: string;
  tool?: string;
  ok?: boolean;
  ms?: number;
  printer?: string;
  /** Printed pages (pages × copies) for a successful print. */
  pages?: number;
  paper?: string;
  source?: string;
  error?: string;
};

export type StoredEvent = UsageEvent & { t: number };

const DAY_TTL = 60 * 60 * 24 * 400;
const MAX_EVENTS = 500;
export const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const clean = (s: string | undefined, n = 60) => (s ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n) || undefined;

// ---------- storage ----------

type Op =
  | { op: "hincr"; key: string; field: string; by: number }
  | { op: "hset"; key: string; field: string; value: string | number }
  | { op: "hsetnx"; key: string; field: string; value: string | number }
  | { op: "sadd"; key: string; member: string }
  | { op: "push"; key: string; value: string; max: number }
  | { op: "expire"; key: string; seconds: number };

interface Store {
  exec(ops: Op[]): Promise<void>;
  hgetall(keys: string[]): Promise<(Record<string, unknown> | null)[]>;
  scard(keys: string[]): Promise<number[]>;
  unionCount(keys: string[]): Promise<number>;
  recent(key: string, n: number): Promise<string[]>;
  scan(match: string): Promise<string[]>;
  getMany<T>(keys: string[]): Promise<(T | null)[]>;
}

function redisStore(r: Redis): Store {
  return {
    async exec(ops) {
      const p = r.pipeline();
      for (const o of ops) {
        if (o.op === "hincr") p.hincrby(o.key, o.field, o.by);
        else if (o.op === "hset") p.hset(o.key, { [o.field]: o.value });
        else if (o.op === "hsetnx") p.hsetnx(o.key, o.field, o.value);
        else if (o.op === "sadd") p.sadd(o.key, o.member);
        else if (o.op === "push") p.lpush(o.key, o.value).ltrim(o.key, 0, o.max - 1);
        else p.expire(o.key, o.seconds);
      }
      await p.exec();
    },
    async hgetall(keys) {
      if (!keys.length) return [];
      const p = r.pipeline();
      keys.forEach((k) => p.hgetall(k));
      return (await p.exec()) as (Record<string, unknown> | null)[];
    },
    async scard(keys) {
      if (!keys.length) return [];
      const p = r.pipeline();
      keys.forEach((k) => p.scard(k));
      return (await p.exec()) as number[];
    },
    async unionCount(keys) {
      return keys.length ? (await r.sunion(keys[0], ...keys.slice(1))).length : 0;
    },
    recent: (key, n) => r.lrange<string>(key, 0, n - 1),
    async scan(match) {
      const out: string[] = [];
      let cursor = "0";
      do {
        const [next, keys] = await r.scan(cursor, { match, count: 500 });
        cursor = String(next);
        out.push(...keys);
      } while (cursor !== "0" && out.length < 10_000);
      return out;
    },
    async getMany<T>(keys: string[]) {
      return keys.length ? r.mget<(T | null)[]>(...keys) : [];
    },
  };
}

// Local development: one process, so a module-level map is enough.
type Mem = { hashes: Map<string, Record<string, unknown>>; sets: Map<string, Set<string>>; lists: Map<string, string[]> };
const g = globalThis as unknown as { __epsonUsageMem?: Mem; __epsonMemKV?: Map<string, { v: string; exp: number }> };

function memoryStore(): Store {
  const m = (g.__epsonUsageMem ??= { hashes: new Map(), sets: new Map(), lists: new Map() });
  const hash = (k: string) => m.hashes.get(k) ?? (m.hashes.set(k, {}), m.hashes.get(k)!);
  const glob = (pattern: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
  return {
    async exec(ops) {
      for (const o of ops) {
        if (o.op === "hincr") hash(o.key)[o.field] = Number(hash(o.key)[o.field] ?? 0) + o.by;
        else if (o.op === "hset") hash(o.key)[o.field] = o.value;
        else if (o.op === "hsetnx") hash(o.key)[o.field] ??= o.value;
        else if (o.op === "sadd") (m.sets.get(o.key) ?? (m.sets.set(o.key, new Set()), m.sets.get(o.key)!)).add(o.member);
        else if (o.op === "push") m.lists.set(o.key, [o.value, ...(m.lists.get(o.key) ?? [])].slice(0, o.max));
      }
    },
    hgetall: async (keys) => keys.map((k) => m.hashes.get(k) ?? null),
    scard: async (keys) => keys.map((k) => m.sets.get(k)?.size ?? 0),
    unionCount: async (keys) => new Set(keys.flatMap((k) => [...(m.sets.get(k) ?? [])])).size,
    recent: async (key, n) => (m.lists.get(key) ?? []).slice(0, n),
    async scan(match) {
      const re = glob(match);
      return [...m.hashes.keys(), ...(g.__epsonMemKV?.keys() ?? [])].filter((k) => re.test(k));
    },
    async getMany<T>(keys: string[]) {
      return keys.map((k) => {
        const e = g.__epsonMemKV?.get(k);
        return e ? (JSON.parse(e.v) as T) : null;
      });
    },
  };
}

let cached: Store | null = null;
function store(): Store {
  if (cached) return cached;
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  return (cached = url && token ? redisStore(new Redis({ url, token, automaticDeserialization: true })) : memoryStore());
}

// ---------- recording ----------

/** Records one event. Never throws: analytics must not break printing. */
export async function recordUsage(input: UsageEvent): Promise<void> {
  try {
    const e: StoredEvent = {
      ...input,
      app: clean(input.app),
      printer: clean(input.printer),
      paper: clean(input.paper, 30),
      source: clean(input.source, 20),
      tool: clean(input.tool, 40),
      error: clean(input.error, 160),
      t: Date.now(),
    };
    const d = day(e.t);
    const dayKey = `stats:day:${d}`;
    const fields: [string, number][] = [[e.type, 1]];
    if (e.type === "tool" && e.tool) {
      fields.push([`tool:${e.tool}`, 1], [`ms:${e.tool}`, Math.round(e.ms ?? 0)]);
      if (!e.ok) fields.push([`err:${e.tool}`, 1]);
      if (e.tool === "print_document" && e.ok) {
        fields.push(["prints", 1], ["pages", e.pages ?? 0]);
        if (e.paper) fields.push([`paper:${e.paper}`, 1]);
        if (e.source) fields.push([`source:${e.source}`, 1]);
      }
    }
    if (e.type === "session" && e.app) fields.push([`app:${e.app}`, 1]);
    if (e.type === "connected" && e.printer) fields.push([`printer:${e.printer}`, 1]);

    const ops: Op[] = [];
    for (const [field, by] of fields) {
      ops.push({ op: "hincr", key: dayKey, field, by }, { op: "hincr", key: "stats:total", field, by });
    }
    ops.push({ op: "expire", key: dayKey, seconds: DAY_TTL });

    if (e.conn) {
      const ck = `stats:conn:${e.conn}`;
      ops.push(
        { op: "sadd", key: `stats:active:${d}`, member: e.conn },
        { op: "expire", key: `stats:active:${d}`, seconds: DAY_TTL },
        { op: "hsetnx", key: ck, field: "firstSeen", value: e.t },
        { op: "hset", key: ck, field: "lastSeen", value: e.t },
      );
      if (e.app) ops.push({ op: "hset", key: ck, field: e.type === "session" ? "mcpClient" : "app", value: e.app });
      if (e.printer) ops.push({ op: "hset", key: ck, field: "printer", value: e.printer });
      if (e.type === "session") ops.push({ op: "hincr", key: ck, field: "sessions", by: 1 });
      if (e.type === "tool") ops.push({ op: "hincr", key: ck, field: "calls", by: 1 });
      if (e.type === "tool" && !e.ok) ops.push({ op: "hincr", key: ck, field: "errors", by: 1 });
      if (e.type === "tool" && e.tool === "print_document" && e.ok) {
        ops.push({ op: "hincr", key: ck, field: "prints", by: 1 }, { op: "hincr", key: ck, field: "pages", by: e.pages ?? 0 });
      }
    }
    ops.push({ op: "push", key: "stats:events", value: JSON.stringify(e), max: MAX_EVENTS });
    await store().exec(ops);
  } catch (err) {
    console.error(`[usage] couldn't record ${input.type}: ${err instanceof Error ? err.message : err}`);
  }
}

// ---------- reading (dashboard) ----------

export type DayStats = { date: string; active: number; counts: Record<string, number> };
export type ConnectionRow = {
  id: string;
  live: boolean;
  printer?: string;
  app?: string;
  mcpClient?: string;
  connectedAt?: string;
  firstSeen?: number;
  lastSeen?: number;
  sessions: number;
  calls: number;
  errors: number;
  prints: number;
  pages: number;
};

const nums = (h: Record<string, unknown> | null) =>
  Object.fromEntries(Object.entries(h ?? {}).map(([k, v]) => [k, Number(v) || 0])) as Record<string, number>;

export async function readUsage(days = 30) {
  const s = store();
  const dates = Array.from({ length: days }, (_, i) => day(Date.now() - (days - 1 - i) * 86_400_000));
  const activeKeys = dates.map((d) => `stats:active:${d}`);

  const [dayHashes, dayActive, [total], active7, activeRange, recentRaw, statKeys, metaKeys] = await Promise.all([
    s.hgetall(dates.map((d) => `stats:day:${d}`)),
    s.scard(activeKeys),
    s.hgetall(["stats:total"]),
    s.unionCount(activeKeys.slice(-7)),
    s.unionCount(activeKeys),
    s.recent("stats:events", 100),
    s.scan("stats:conn:*"),
    s.scan("conn:*:meta"),
  ]);

  // Connections: union of live Epson connections (conn:<id>:meta) and ones seen in stats.
  type Meta = { clientName?: string; productName?: string; createdAt?: string };
  const metaIds = metaKeys.map((k) => k.slice(5, -5));
  const statIds = statKeys.map((k) => k.slice("stats:conn:".length));
  const ids = [...new Set([...metaIds, ...statIds])];
  const [metas, stats] = await Promise.all([s.getMany<Meta>(ids.map((id) => `conn:${id}:meta`)), s.hgetall(ids.map((id) => `stats:conn:${id}`))]);
  const connections: ConnectionRow[] = ids.map((id, i) => {
    const m = metas[i];
    const st = stats[i] ?? {};
    const n = nums(st);
    return {
      id,
      live: !!m,
      printer: m?.productName ?? (st.printer as string | undefined),
      app: m?.clientName ?? (st.app as string | undefined),
      mcpClient: st.mcpClient as string | undefined,
      connectedAt: m?.createdAt,
      firstSeen: n.firstSeen || (m?.createdAt ? Date.parse(m.createdAt) : undefined),
      lastSeen: n.lastSeen || undefined,
      sessions: n.sessions ?? 0,
      calls: n.calls ?? 0,
      errors: n.errors ?? 0,
      prints: n.prints ?? 0,
      pages: n.pages ?? 0,
    };
  });
  connections.sort((a, b) => (b.lastSeen ?? b.firstSeen ?? 0) - (a.lastSeen ?? a.firstSeen ?? 0));

  const recent = recentRaw
    .map((r) => {
      try {
        return (typeof r === "string" ? JSON.parse(r) : r) as StoredEvent;
      } catch {
        return null;
      }
    })
    .filter((e): e is StoredEvent => !!e);

  return {
    dates: dates.map((date, i): DayStats => ({ date, active: dayActive[i] ?? 0, counts: nums(dayHashes[i]) })),
    total: nums(total),
    active7,
    activeRange,
    connections,
    recent,
  };
}

export type Usage = Awaited<ReturnType<typeof readUsage>>;
