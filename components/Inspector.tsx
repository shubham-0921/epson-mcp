"use client";

import { useEffect, useRef, useState } from "react";
import type { ApiLogEntry } from "@/lib/epson/types";
import { toCurl } from "@/lib/ui/curl";
import JsonView from "./JsonView";

const METHOD_STYLE: Record<string, string> = {
  GET: "bg-ok-bg text-ok",
  POST: "bg-info-bg text-accent",
  PUT: "bg-warn-bg text-warn",
  DELETE: "bg-err-bg text-err",
};

export function StateIcon({ status }: { status: ApiLogEntry["status"] }) {
  if (status === "running")
    return <span aria-label="running" className="inline-block size-3.5 animate-spin rounded-full border-2 border-accent border-t-transparent" />;
  if (status === "success") return <span aria-label="success" className="inline-block size-3.5 rounded-full bg-ok" />;
  if (status === "error")
    return (
      <span aria-label="failed" className="grid size-3.5 place-items-center rounded-full bg-err text-[9px] font-bold leading-none text-white">
        ✕
      </span>
    );
  return <span aria-label="pending" className="inline-block size-3.5 rounded-full border-2 border-muted/50" />;
}

function shortUrl(url: string) {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/api\/2/, "");
    return u.hostname.startsWith("auth.") || u.hostname.startsWith("api.") ? path : `${u.hostname}${path}`;
  } catch {
    return url;
  }
}

function statusColor(code?: number) {
  if (!code) return "text-muted";
  if (code < 300) return "text-ok";
  if (code < 400) return "text-accent";
  return "text-err";
}

function Entry({ e, defaultOpen }: { e: ApiLogEntry; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(!!defaultOpen);
  const [tab, setTab] = useState<"request" | "response">("response");
  const [copied, setCopied] = useState(false);
  const isPlaceholder = e.status === "pending";
  const [prevStatus, setPrevStatus] = useState(e.status);
  if (prevStatus !== e.status) {
    // A call that just failed opens itself so its error body is visible.
    setPrevStatus(e.status);
    if (e.status === "error") setOpen(true);
  }

  const copy = async () => {
    await navigator.clipboard.writeText(toCurl(e));
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  return (
    <li className="relative pl-7">
      <span className="absolute left-0 top-3.5 z-10 grid size-3.5 place-items-center bg-panel">
        <StateIcon status={e.status} />
      </span>
      <div className={`rounded-lg border ${e.status === "error" ? "border-err/40" : "border-line"} bg-panel`}>
        <button
          type="button"
          disabled={isPlaceholder}
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left disabled:cursor-default"
        >
          <span className={`w-12 shrink-0 rounded px-1.5 py-0.5 text-center font-mono text-[11px] font-semibold ${METHOD_STYLE[e.method]}`}>
            {e.method}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium">{e.label}</span>
            <span className="block truncate font-mono text-[11.5px] text-muted">{shortUrl(e.url)}</span>
          </span>
          <span className="shrink-0 text-right font-mono text-[12px]">
            {e.status === "running" ? (
              <span className="text-accent">running…</span>
            ) : isPlaceholder ? (
              <span className="text-muted">pending</span>
            ) : (
              <>
                <span className={statusColor(e.response?.status)}>{e.response?.status ?? "ERR"}</span>
                <span className="ml-2 text-muted">{e.durationMs ?? 0}ms</span>
              </>
            )}
          </span>
          {!isPlaceholder && <span className={`shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""}`}>▸</span>}
        </button>

        {open && !isPlaceholder && (
          <div className="border-t border-line px-3 pb-3 pt-2.5">
            <div className="mb-2 break-all font-mono text-[11.5px] text-muted">
              <span className="font-semibold text-fg">{e.method}</span> {e.url}
            </div>
            <div className="mb-2 text-[11px] text-muted">{new Date(e.startedAt).toLocaleTimeString(undefined, { hour12: false })} · {e.startedAt}</div>
            {e.error && (
              <div className="mb-2 rounded-md bg-err-bg px-2.5 py-1.5 text-[12px] text-err">{e.error}</div>
            )}
            <div className="mb-2 flex items-center gap-1">
              {(["request", "response"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTab(t)}
                  className={`rounded-md px-2.5 py-1 text-[12px] font-medium capitalize ${tab === t ? "bg-panel-2 text-fg" : "text-muted hover:text-fg"}`}
                >
                  {t}
                </button>
              ))}
              {e.step !== "authorize" && (
                <button
                  type="button"
                  onClick={copy}
                  className="ml-auto rounded-md border border-line px-2.5 py-1 text-[12px] font-medium text-muted hover:text-fg"
                >
                  {copied ? "Copied ✓" : "Copy as cURL"}
                </button>
              )}
            </div>
            {tab === "request" ? (
              <div className="space-y-2">
                <Section title="Headers"><JsonView value={e.request.headers} empty="(no headers)" /></Section>
                <Section title="Body"><JsonView value={e.request.body} empty="(no body)" /></Section>
              </div>
            ) : e.response ? (
              <div className="space-y-2">
                <Section title={`Status ${e.response.status}`}><JsonView value={e.response.headers} empty="(no headers)" /></Section>
                <Section title="Body"><JsonView value={e.response.body} empty="(empty body)" /></Section>
              </div>
            ) : (
              <div className="text-[12px] text-muted">No response received.</div>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">{title}</div>
      {children}
    </div>
  );
}

export default function Inspector({ log, onClear, onExport }: { log: ApiLogEntry[]; onClear: () => void; onExport: () => void }) {
  const done = log.filter((e) => e.status !== "pending");
  const scroller = useRef<HTMLDivElement>(null);
  const activity = log.filter((e) => e.status !== "pending").length + log.length;
  const prev = useRef(activity);
  useEffect(() => {
    // Follow new calls (and placeholders turning live) as they arrive.
    if (activity > prev.current) scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
    prev.current = activity;
  }, [activity]);
  return (
    <section className="flex h-full min-h-0 flex-col rounded-xl border border-line bg-panel">
      <header className="flex items-center gap-2 border-b border-line px-4 py-3">
        <h2 className="text-[14px] font-semibold">API Call Inspector</h2>
        <span className="rounded-full bg-panel-2 px-2 py-0.5 font-mono text-[11px] text-muted">{done.length} calls</span>
        <div className="ml-auto flex gap-1.5">
          <button type="button" onClick={onExport} disabled={!done.length} className="rounded-md border border-line px-2.5 py-1 text-[12px] font-medium text-muted hover:text-fg disabled:opacity-40">
            Export JSON
          </button>
          <button type="button" onClick={onClear} disabled={!log.length} className="rounded-md border border-line px-2.5 py-1 text-[12px] font-medium text-muted hover:text-fg disabled:opacity-40">
            Clear log
          </button>
        </div>
      </header>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto p-4">
        {log.length === 0 ? (
          <div className="grid h-full min-h-60 place-items-center text-center text-[13px] text-muted">
            <div>
              <div className="mb-1 font-mono text-[22px] opacity-50">{"{ }"}</div>
              Every Epson Connect call will appear here — request, response, status and timing.
              <br />
              Secrets are always redacted.
            </div>
          </div>
        ) : (
          <ol className="relative space-y-2.5 before:absolute before:bottom-4 before:left-[6px] before:top-4 before:w-px before:bg-line">
            {log.map((e, i) => (
              <Entry key={e.id} e={e} defaultOpen={e.status === "error" && i === log.length - 1} />
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
