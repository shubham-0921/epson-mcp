import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { adminConfigured, isAdmin } from "@/lib/analytics/admin-auth";
import { readUsage, type DayStats, type StoredEvent, type Usage } from "@/lib/analytics/usage";
import { signIn, signOut } from "./actions";
import { BarChart } from "./bar-chart";

export const metadata: Metadata = { title: "MCP usage · Epson Print", robots: { index: false, follow: false } };

const RANGES = [7, 30, 90] as const;
const TOOLS = ["print_document", "get_print_job_status", "get_print_options", "get_printer_status"];

export default function AdminPage({ searchParams }: PageProps<"/admin">) {
  return (
    <main className="min-h-screen bg-bg text-fg">
      <Suspense fallback={<div className="p-6 text-[13px] text-muted">Loading…</div>}>
        <Gate searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function Gate({ searchParams }: { searchParams: PageProps<"/admin">["searchParams"] }) {
  await connection(); // always render at request time (live numbers, Date.now())
  const sp = await searchParams;
  if (!adminConfigured()) {
    return (
      <Centered>
        <h1 className="text-[17px] font-semibold">Usage dashboard is off</h1>
        <p className="mt-2 text-[13px] text-muted">
          Set <code className="font-mono">ADMIN_PASSWORD</code> (12+ characters) in the server environment to turn it on.
        </p>
      </Centered>
    );
  }
  if (!(await isAdmin())) {
    const error = sp.error === "locked" ? "Too many attempts. Try again in 15 minutes." : sp.error ? "Wrong password." : null;
    return (
      <Centered>
        <h1 className="text-[17px] font-semibold">Epson Print MCP · Usage</h1>
        <form action={signIn} className="mt-4 space-y-3">
          <label className="block text-[12px] font-medium text-muted" htmlFor="password">
            Admin password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            required
            autoFocus
            autoComplete="current-password"
            className="w-full rounded-md border border-line bg-panel-2 px-3 py-2 text-[14px] outline-none focus:border-accent"
          />
          {error && <p className="text-[12px] text-err">{error}</p>}
          <button className="w-full rounded-md bg-accent px-3 py-2 text-[13px] font-semibold text-accent-fg">Sign in</button>
        </form>
      </Centered>
    );
  }
  const days = RANGES.find((r) => String(r) === sp.days) ?? 30;
  return <Dashboard usage={await readUsage(days)} days={days} />;
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center px-4">
      <div className="w-full max-w-sm rounded-xl border border-line bg-panel p-6">{children}</div>
    </div>
  );
}

// ---------- dashboard ----------

const sum = (ds: DayStats[], field: string) => ds.reduce((n, d) => n + (d.counts[field] ?? 0), 0);

function prefixed(ds: DayStats[], prefix: string) {
  const out = new Map<string, number>();
  for (const d of ds) for (const [k, v] of Object.entries(d.counts)) if (k.startsWith(prefix)) out.set(k.slice(prefix.length), (out.get(k.slice(prefix.length)) ?? 0) + v);
  return [...out].sort((a, b) => b[1] - a[1]);
}

const fmt = (n: number) => n.toLocaleString("en-US");
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");
const shortDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

function ago(t?: number) {
  if (!t) return "—";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

function Dashboard({ usage, days }: { usage: Usage; days: number }) {
  const ds = usage.dates;
  const live = usage.connections.filter((c) => c.live).length;
  const toolCalls = TOOLS.reduce((n, t) => n + sum(ds, `tool:${t}`), 0);
  const printCalls = sum(ds, "tool:print_document");
  const prints = sum(ds, "prints");
  const registered = sum(ds, "client_registered");
  const connected = sum(ds, "connected");
  const connectFailed = sum(ds, "connect_failed");
  const apps = prefixed(ds, "app:");
  const papers = prefixed(ds, "paper:");
  const sources = prefixed(ds, "source:");
  const printers = [...usage.connections.reduce((m, c) => m.set(c.printer ?? "Unknown", (m.get(c.printer ?? "Unknown") ?? 0) + 1), new Map<string, number>())].sort(
    (a, b) => b[1] - a[1],
  );

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-4 py-5 sm:px-6">
      <header className="flex flex-wrap items-center gap-3">
        <div className="grid size-8 place-items-center rounded-lg bg-accent font-mono text-[13px] font-bold text-accent-fg">E</div>
        <div className="min-w-0">
          <h1 className="text-[15px] font-semibold leading-tight">Epson Print MCP · Usage</h1>
          <p className="text-[12px] text-muted">Remote server at /api/mcp · days in UTC</p>
        </div>
        <nav className="ml-auto flex items-center gap-1 rounded-md border border-line bg-panel p-0.5" aria-label="Date range">
          {RANGES.map((r) => (
            <Link
              key={r}
              href={`/admin?days=${r}`}
              aria-current={r === days ? "page" : undefined}
              className={`rounded px-2.5 py-1 text-[12px] font-medium ${r === days ? "bg-accent text-accent-fg" : "text-muted hover:text-fg"}`}
            >
              {r} days
            </Link>
          ))}
        </nav>
        <form action={signOut}>
          <button className="rounded-md border border-line px-2.5 py-1.5 text-[12px] font-medium text-muted hover:text-fg">Sign out</button>
        </form>
      </header>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6" aria-label="Headline numbers">
        <Stat label="Connected printers" value={fmt(live)} hint={`${fmt(usage.connections.length)} ever seen`} />
        <Stat label="Active · 7 days" value={fmt(usage.active7)} hint="connections that made a request" />
        {days === 7 ? (
          <Stat label="Sessions · 7 days" value={fmt(sum(ds, "session"))} hint="conversations that used the server" />
        ) : (
          <Stat label={`Active · ${days} days`} value={fmt(usage.activeRange)} hint="connections that made a request" />
        )}
        <Stat label="Print jobs" value={fmt(prints)} hint={`${pct(prints, printCalls)} of ${fmt(printCalls)} attempts succeeded`} />
        <Stat label="Pages printed" value={fmt(sum(ds, "pages"))} hint="pages × copies" />
        <Stat label="New connections" value={fmt(connected)} hint={`${fmt(connectFailed)} failed sign-ins`} />
      </section>

      <section className="grid gap-3 md:grid-cols-2">
        <Panel title="Active connections per day">
          <BarChart data={ds.map((d) => ({ label: shortDate(d.date), value: d.active }))} unit="active connections" />
        </Panel>
        <Panel title="Print jobs per day">
          <BarChart data={ds.map((d) => ({ label: shortDate(d.date), value: d.counts.prints ?? 0 }))} unit="print jobs" />
        </Panel>
      </section>

      <section className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        <Panel title="Sign-up funnel">
          <Table
            head={["Step", "Count"]}
            rows={[
              ["Connector added (client registered)", fmt(registered)],
              ["Epson sign-in completed", fmt(connected)],
              ["Epson sign-in failed", fmt(connectFailed)],
              ["Sessions started", fmt(sum(ds, "session"))],
              ["Rejected tokens (expired / revoked)", fmt(sum(ds, "invalid_token"))],
              ["Hit the hourly print limit", fmt(sum(ds, "rate_limited"))],
            ]}
          />
        </Panel>
        <Panel title="Tools">
          <Table
            head={["Tool", "Calls", "Errors", "Avg time"]}
            rows={TOOLS.map((t) => {
              const calls = sum(ds, `tool:${t}`);
              return [<code key={t} className="font-mono text-[12px]">{t}</code>, fmt(calls), pct(sum(ds, `err:${t}`), calls), calls ? `${(sum(ds, `ms:${t}`) / calls / 1000).toFixed(1)} s` : "—"];
            })}
            foot={["All tools", fmt(toolCalls), pct(TOOLS.reduce((n, t) => n + sum(ds, `err:${t}`), 0), toolCalls), ""]}
          />
        </Panel>
        <Panel title="AI apps (sessions)">
          <Breakdown rows={apps} empty="No sessions yet" />
        </Panel>
        <Panel title="Printer models (connections)">
          <Breakdown rows={printers} empty="No connections yet" />
        </Panel>
        <Panel title="Paper sizes (print jobs)">
          <Breakdown rows={papers} empty="No prints yet" />
        </Panel>
        <Panel title="Document source (print jobs)">
          <Breakdown rows={sources} empty="No prints yet" />
        </Panel>
      </section>

      <Panel title={`Connections (${usage.connections.length})`}>
        <Table
          head={["Connection", "Printer", "App", "Connected", "Last active", "Sessions", "Calls", "Prints", "Pages"]}
          rows={usage.connections.map((c) => [
            <span key="id" className="whitespace-nowrap font-mono text-[12px]">
              <span className={`mr-1.5 inline-block size-2 rounded-full ${c.live ? "bg-ok" : "bg-line"}`} aria-hidden />
              {c.id.slice(0, 6)}
              <span className="sr-only">{c.live ? " (connected)" : " (expired)"}</span>
            </span>,
            c.printer ?? "—",
            c.mcpClient ?? c.app ?? "—",
            c.firstSeen ? new Date(c.firstSeen).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "—",
            ago(c.lastSeen),
            fmt(c.sessions),
            fmt(c.calls),
            fmt(c.prints),
            fmt(c.pages),
          ])}
          empty="Nobody has connected yet."
          numeric={[5, 6, 7, 8]}
        />
        <p className="mt-2 text-[11px] text-muted">Green dot: Epson connection still stored. Grey: expired or revoked. Usage before this dashboard shipped isn&apos;t counted.</p>
      </Panel>

      <Panel title="Recent activity">
        <Table
          head={["When", "Event", "Connection", "Details"]}
          rows={usage.recent.slice(0, 60).map((e, i) => [
            <span key={i} className="whitespace-nowrap" title={new Date(e.t).toISOString()}>
              {ago(e.t)}
            </span>,
            <EventLabel key="ev" e={e} />,
            <span key="c" className="font-mono text-[12px]">{e.conn?.slice(0, 6) ?? "—"}</span>,
            <span key="d" className="text-muted">{details(e)}</span>,
          ])}
          empty="No activity yet."
          numeric={[]}
        />
      </Panel>
    </div>
  );
}

function details(e: StoredEvent) {
  if (e.type === "tool") {
    const parts = [e.ms !== undefined ? `${(e.ms / 1000).toFixed(1)} s` : null];
    if (e.tool === "print_document" && e.ok) parts.push(`${e.pages ?? "?"} page(s)`, e.paper ?? null, e.source ?? null);
    if (!e.ok && e.error) parts.push(e.error);
    return parts.filter(Boolean).join(" · ");
  }
  return [e.app, e.printer, e.error].filter(Boolean).join(" · ") || "";
}

const EVENT_TEXT: Record<StoredEvent["type"], string> = {
  client_registered: "Connector added",
  connected: "Printer connected",
  connect_failed: "Sign-in failed",
  session: "Session started",
  tool: "Tool call",
  rate_limited: "Print limit hit",
  invalid_token: "Token rejected",
};

function EventLabel({ e }: { e: StoredEvent }) {
  const bad = (e.type === "tool" && !e.ok) || e.type === "connect_failed" || e.type === "rate_limited";
  return (
    <span className="whitespace-nowrap">
      {bad && <span className="mr-1 font-semibold text-err" aria-label="failed">✕</span>}
      {e.type === "tool" ? <code className="font-mono text-[12px]">{e.tool}</code> : EVENT_TEXT[e.type]}
    </span>
  );
}

// ---------- building blocks ----------

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-xl border border-line bg-panel p-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 text-[24px] font-semibold tabular-nums leading-tight">{value}</div>
      <div className="mt-0.5 text-[11px] text-muted">{hint}</div>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0 rounded-xl border border-line bg-panel p-4">
      <h2 className="mb-3 text-[13px] font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Table({
  head,
  rows,
  foot,
  empty = "Nothing yet.",
  numeric,
}: {
  head: string[];
  rows: React.ReactNode[][];
  foot?: React.ReactNode[];
  empty?: string;
  numeric?: number[];
}) {
  const num = (i: number) => (numeric ? numeric.includes(i) : i > 0);
  if (!rows.length) return <p className="text-[12px] text-muted">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-muted">
            {head.map((h, i) => (
              <th key={h} className={`py-1.5 pr-3 font-medium ${num(i) ? "text-right" : ""}`}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-line/60 last:border-0">
              {r.map((c, j) => (
                <td key={j} className={`py-1.5 pr-3 align-top ${num(j) ? "text-right tabular-nums" : ""}`}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {foot && (
          <tfoot>
            <tr className="border-t border-line font-semibold">
              {foot.map((c, j) => (
                <td key={j} className={`py-1.5 pr-3 ${num(j) ? "text-right tabular-nums" : ""}`}>
                  {c}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

function Breakdown({ rows, empty }: { rows: [string, number][]; empty: string }) {
  if (!rows.length) return <p className="text-[12px] text-muted">{empty}</p>;
  const max = Math.max(...rows.map((r) => r[1]));
  const top = rows.slice(0, 7);
  const rest = rows.slice(7).reduce((n, r) => n + r[1], 0);
  if (rest) top.push(["Other", rest]);
  return (
    <ul className="space-y-1.5 text-[13px]">
      {top.map(([name, n]) => (
        <li key={name} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3">
          <span className="truncate" title={name}>
            {name}
          </span>
          <span className="tabular-nums text-muted">{fmt(n)}</span>
          <span className="col-span-2 h-1.5 rounded-full bg-panel-2">
            <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.max(2, (n / max) * 100)}%` }} />
          </span>
        </li>
      ))}
    </ul>
  );
}
