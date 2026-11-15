"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiLogEntry, ApiStep, Capability, DeviceInfo, JobInfo, PrintMode, PrintSettings } from "@/lib/epson/types";
import Inspector, { StateIcon } from "./Inspector";
import Settings, { resolveSettings } from "./Settings";
import FileDrop from "./FileDrop";
import JobStatus, { type JobTracking } from "./JobStatus";

type Session = { connected: boolean; mock: boolean };
type RunState = { phase: "idle" | "running" | "done" | "error" | "stopped"; jobId?: string; failedStep?: ApiStep; error?: string; body?: unknown };
type ErrorPayload = { error: string; code?: string; status?: number; body?: unknown; log?: ApiLogEntry[] };

class ApiError extends Error {
  constructor(public payload: ErrorPayload) {
    super(payload.error);
  }
}

const LOG_KEY = "epc-log";
const API = "https://api.epsonconnect.com/api/2";
const STEP_LABEL: Partial<Record<ApiStep, string>> = { createJob: "step 3 (create job)", upload: "step 4 (upload)", print: "step 5 (execute print)" };

function placeholders(): ApiLogEntry[] {
  const now = new Date().toISOString();
  const ph = (step: ApiStep, label: string, url: string, method: "GET" | "POST" = "POST"): ApiLogEntry => ({
    id: `ph-${step}`, step, label, method, url, request: { headers: {} }, status: "pending", startedAt: now,
  });
  return [
    ph("createJob", "3 · Create print job", `${API}/printing/jobs`),
    ph("upload", "4 · Upload file", "{uploadUri}&File=1.<ext>"),
    ph("print", "5 · Execute print", `${API}/printing/jobs/{jobId}/print`),
    ph("jobInfo", "6 · Get print job information", `${API}/printing/jobs/{jobId}`, "GET"),
  ];
}

// Poll quickly at first, then back off. Stop after 3 minutes.
const POLL_DELAYS = [1500, 2000, 2500, 3000, 3000, 4000, 5000];
const POLL_LIMIT_MS = 3 * 60 * 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function dropPlaceholders(keepJobInfo = false) {
  return (prev: ApiLogEntry[]) => prev.filter((e) => !e.id.startsWith("ph-") || (keepJobInfo && e.id === "ph-jobInfo"));
}

export default function Console() {
  const [session, setSession] = useState<Session | null>(null);
  const [log, setLog] = useState<ApiLogEntry[]>([]);
  const [banner, setBanner] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const [device, setDevice] = useState<DeviceInfo | null>(null);
  const [deviceState, setDeviceState] = useState<"idle" | "loading" | "error">("idle");
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<PrintMode>("document");
  const [caps, setCaps] = useState<Partial<Record<PrintMode, Capability>>>({});
  const [capError, setCapError] = useState<string | null>(null);
  const [settings, setSettings] = useState<PrintSettings | null>(null);
  const [run, setRun] = useState<RunState>({ phase: "idle" });
  const [stepMode, setStepMode] = useState(false);
  const [gate, setGate] = useState<{ label: string; resolve: (go: boolean) => void } | null>(null);
  const [theme, setTheme] = useState<"system" | "light" | "dark">("system");
  const [job, setJob] = useState<JobTracking | null>(null);
  const pollToken = useRef(0);
  const capInFlight = useRef(new Set<PrintMode>());
  const logLoaded = useRef(false);

  // ---------- log ----------
  const addEntries = useCallback((entries: ApiLogEntry[] | undefined) => {
    if (!entries?.length) return;
    setLog((prev) => {
      const next = [...prev];
      for (const e of entries) {
        const i = next.findIndex((x) => x.id === e.id);
        if (i >= 0) { next[i] = e; continue; }
        const ph = next.findIndex((x) => x.id === `ph-${e.step}`);
        if (ph >= 0) { next[ph] = e; continue; }
        const firstPh = next.findIndex((x) => x.id.startsWith("ph-"));
        if (firstPh >= 0) next.splice(firstPh, 0, e);
        else next.push(e);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(LOG_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate per-tab log once
      if (saved) setLog((prev) => [...(JSON.parse(saved) as ApiLogEntry[]).filter((e) => e.status !== "pending" && e.status !== "running"), ...prev]);
      const t = localStorage.getItem("epc-theme");
      if (t === "light" || t === "dark") setTheme(t);
    } catch { /* storage unavailable */ }
    logLoaded.current = true;
  }, []);

  useEffect(() => {
    if (!logLoaded.current) return;
    try { sessionStorage.setItem(LOG_KEY, JSON.stringify(log.filter((e) => !e.id.startsWith("ph-")))); } catch { /* ignore */ }
  }, [log]);

  const handleReconnect = useCallback(() => {
    setSession((s) => (s ? { ...s, connected: false } : s));
    setDevice(null);
    setCaps({});
    setSettings(null);
    setBanner({ kind: "error", text: "Your Epson session expired or was revoked. Reconnect the printer." });
  }, []);

  const api = useCallback(
    async <T,>(url: string, init?: RequestInit): Promise<T> => {
      const res = await fetch(url, init);
      const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      addEntries(data.log);
      if (!res.ok) {
        if (data.code === "reconnect") handleReconnect();
        throw new ApiError(data);
      }
      return data as T;
    },
    [addEntries, handleReconnect],
  );

  // ---------- session ----------
  useEffect(() => {
    const url = new URL(window.location.href);
    const err = url.searchParams.get("error");
    if (err) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time read of OAuth callback result
      setBanner({ kind: "error", text: err === "state_mismatch" ? "Sign-in rejected: OAuth state did not match (possible CSRF). Try connecting again." : `Couldn’t connect: ${err}` });
      url.searchParams.delete("error");
      window.history.replaceState(null, "", url.pathname);
    }
    fetch("/api/session")
      .then((r) => r.json())
      .then((d: Session & { log: ApiLogEntry[] }) => {
        setSession({ connected: d.connected, mock: d.mock });
        addEntries(d.log);
      })
      .catch(() => setSession({ connected: false, mock: false }));
  }, [addEntries]);

  const loadDevice = useCallback(async () => {
    setDeviceState("loading");
    try {
      const d = await api<{ device: DeviceInfo }>("/api/printer");
      setDevice(d.device);
      setDeviceState("idle");
    } catch (e) {
      setDeviceState("error");
      if (e instanceof ApiError && e.payload.code !== "reconnect") setBanner({ kind: "error", text: `Couldn’t read printer info: ${e.message}` });
    }
  }, [api]);

  const loadCap = useCallback(
    async (m: PrintMode) => {
      if (capInFlight.current.has(m)) return;
      capInFlight.current.add(m);
      setCapError(null);
      try {
        const d = await api<{ capability: Capability }>(`/api/capability?mode=${m}`);
        setCaps((c) => ({ ...c, [m]: d.capability }));
      } catch (e) {
        if (e instanceof ApiError && e.payload.code !== "reconnect") setCapError(e.message);
      } finally {
        capInFlight.current.delete(m);
      }
    },
    [api],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch printer info once connected
    if (session?.connected) loadDevice();
  }, [session?.connected, loadDevice]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch capabilities for the current mode
    if (session?.connected && device && !caps[mode]) loadCap(mode);
  }, [session?.connected, device, mode, caps, loadCap]);

  const cap = caps[mode] ?? null;
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset to the first valid combination for this mode
    setSettings(cap ? resolveSettings(cap) : null);
  }, [cap]);

  // ---------- actions ----------
  const disconnect = async () => {
    pollToken.current++;
    setJob(null);
    await fetch("/api/auth/logout", { method: "POST" });
    setSession((s) => (s ? { ...s, connected: false } : s));
    setDevice(null);
    setCaps({});
    setSettings(null);
    setRun({ phase: "idle" });
    setBanner({ kind: "info", text: "Disconnected. Tokens were cleared from the server session." });
  };

  const onFile = (f: File | null, err?: string) => {
    setFile(f);
    setRun({ phase: "idle" });
    if (err) setBanner({ kind: "error", text: err });
    else setBanner(null);
    if (f) setMode(f.type === "application/pdf" ? "document" : "photo");
  };

  const runStreamed = async (f: File, s: PrintSettings): Promise<string | undefined> => {
    const fd = new FormData();
    fd.append("file", f);
    fd.append("printMode", mode);
    fd.append("settings", JSON.stringify(s));
    const res = await fetch("/api/print", { method: "POST", body: fd });
    if (!res.ok || !res.body) {
      const data: ErrorPayload = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      addEntries(data.log);
      if (data.code === "reconnect") handleReconnect();
      setRun({ phase: "error", error: data.error, body: data.body });
      return;
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    let finished = false;
    let jobId: string | undefined;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const evt = JSON.parse(line);
        if (evt.type === "log") addEntries([evt.entry]);
        else if (evt.type === "done") { finished = true; jobId = evt.jobId; setRun({ phase: "done", jobId: evt.jobId }); }
        else if (evt.type === "error") { finished = true; setRun({ phase: "error", failedStep: evt.step, error: evt.error, body: evt.body }); }
      }
    }
    if (!finished) setRun({ phase: "error", error: "Connection to the server was lost before the print finished." });
    return jobId;
  };

  const runStepped = async (f: File, s: PrintSettings): Promise<string | undefined> => {
    const waitGate = (label: string) => new Promise<boolean>((resolve) => setGate({ label, resolve }));
    const fail = (step: ApiStep, e: unknown): undefined => {
      const p = e instanceof ApiError ? e.payload : { error: String(e) };
      setRun({ phase: "error", failedStep: step, error: p.error, body: p.body });
    };
    const stop = (): undefined => {
      setRun({ phase: "stopped" });
    };

    if (!(await waitGate("3 · Create print job"))) return stop();
    setGate(null);
    let job: { jobId: string; ticket: string };
    try {
      job = await api("/api/print/job", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ printMode: mode, settings: s, fileName: f.name }) });
    } catch (e) { return fail("createJob", e); }

    if (!(await waitGate("4 · Upload file"))) return stop();
    setGate(null);
    try {
      const fd = new FormData();
      fd.append("file", f);
      fd.append("ticket", job.ticket);
      await api("/api/print/upload", { method: "POST", body: fd });
    } catch (e) { return fail("upload", e); }

    if (!(await waitGate("5 · Execute print"))) return stop();
    setGate(null);
    try {
      await api("/api/print/execute", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jobId: job.jobId }) });
    } catch (e) { return fail("print", e); }
    setRun({ phase: "done", jobId: job.jobId });
    return job.jobId;
  };

  /** Call 6 — poll Get print job information until the job is completed or canceled. */
  const pollJob = async (jobId: string, gated: boolean) => {
    const token = ++pollToken.current;
    const alive = () => pollToken.current === token;
    const end = (patch: Partial<JobTracking>) => {
      if (!alive()) return;
      setJob((j) => (j ? { ...j, ...patch } : j));
      setLog(dropPlaceholders());
    };

    setJob((j) => ({ jobId, phase: gated ? "waiting" : "polling", info: j?.jobId === jobId ? j.info : null, checks: j?.jobId === jobId ? j.checks : 0 }));
    if (gated) {
      const go = await new Promise<boolean>((resolve) => setGate({ label: "6 · Get print job information", resolve }));
      setGate(null);
      if (!alive()) return;
      if (!go) return end({ phase: "stopped" });
      setJob((j) => (j ? { ...j, phase: "polling" } : j));
    }

    const started = Date.now();
    for (let attempt = 1; ; attempt++) {
      let info: JobInfo;
      try {
        info = (await api<{ job: JobInfo }>(`/api/print/status?jobId=${encodeURIComponent(jobId)}&attempt=${attempt}`)).job;
      } catch (e) {
        return end({ phase: "error", error: e instanceof Error ? e.message : String(e) });
      }
      if (!alive()) return;
      setJob((j) => (j ? { ...j, info, checks: j.checks + 1 } : j));
      if (info.final) return end({ phase: "final" });
      if (Date.now() - started > POLL_LIMIT_MS) return end({ phase: "timeout" });
      await sleep(POLL_DELAYS[Math.min(attempt - 1, POLL_DELAYS.length - 1)]);
      if (!alive()) return;
    }
  };

  const stopPolling = () => {
    pollToken.current++;
    setJob((j) => (j ? { ...j, phase: "stopped" } : j));
    setLog(dropPlaceholders());
  };

  const print = async () => {
    if (!file || !settings || !device?.connected) return;
    setBanner(null);
    pollToken.current++; // stop tracking any previous job
    setJob(null);
    setRun({ phase: "running" });
    setLog((prev) => [...dropPlaceholders()(prev), ...placeholders()]);
    let jobId: string | undefined;
    try {
      jobId = stepMode ? await runStepped(file, settings) : await runStreamed(file, settings);
    } catch (e) {
      setRun({ phase: "error", error: e instanceof Error ? e.message : String(e) });
    } finally {
      setGate(null);
      setLog(dropPlaceholders(!!jobId));
    }
    if (jobId) void pollJob(jobId, stepMode);
  };

  const exportLog = () => {
    const blob = new Blob([JSON.stringify(log.filter((e) => !e.id.startsWith("ph-")), null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `epson-api-log-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const cycleTheme = () => {
    const next = theme === "system" ? "light" : theme === "light" ? "dark" : "system";
    setTheme(next);
    try {
      if (next === "system") { localStorage.removeItem("epc-theme"); delete document.documentElement.dataset.theme; }
      else { localStorage.setItem("epc-theme", next); document.documentElement.dataset.theme = next; }
    } catch { /* ignore */ }
  };

  const busy = run.phase === "running";
  const offline = device && !device.connected;
  const canPrint = !!file && !!settings && !!device?.connected && !busy;

  // ---------- render ----------
  return (
    <div className="flex min-h-screen flex-col">
      {session?.mock && (
        <div className="bg-warn-bg px-4 py-1.5 text-center font-mono text-[12px] font-semibold tracking-wide text-warn">
          MOCK MODE — responses are simulated (EPSON_MOCK=true). No real printer is contacted.
        </div>
      )}
      <header className="flex items-center gap-3 border-b border-line bg-panel px-4 py-3 sm:px-6">
        <div className="grid size-8 place-items-center rounded-lg bg-accent font-mono text-[13px] font-bold text-accent-fg">EP</div>
        <div className="min-w-0">
          <h1 className="text-[15px] font-semibold leading-tight">Epson Print Console</h1>
          <p className="truncate text-[12px] text-muted">Epson Connect API 2.0 · every call, live</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <label className="flex cursor-pointer items-center gap-2 rounded-md border border-line px-2.5 py-1.5 text-[12px] font-medium">
            <input type="checkbox" checked={stepMode} disabled={busy} onChange={(e) => setStepMode(e.target.checked)} />
            Step-by-step
          </label>
          <button type="button" onClick={cycleTheme} className="rounded-md border border-line px-2.5 py-1.5 text-[12px] font-medium capitalize text-muted hover:text-fg" title="Theme">
            {theme === "dark" ? "☾ Dark" : theme === "light" ? "☀ Light" : "◐ System"}
          </button>
        </div>
      </header>

      <main className="grid flex-1 gap-4 p-4 sm:p-6 md:grid-cols-[minmax(320px,420px)_1fr]">
        {/* LEFT: Print */}
        <div className="space-y-4">
          {banner && (
            <div className={`flex items-start gap-2 rounded-lg px-3 py-2.5 text-[13px] ${banner.kind === "error" ? "bg-err-bg text-err" : "bg-info-bg text-accent"}`}>
              <span className="flex-1">{banner.text}</span>
              <button type="button" onClick={() => setBanner(null)} className="opacity-70 hover:opacity-100" aria-label="Dismiss">✕</button>
            </div>
          )}

          {!session ? (
            <div className="h-40 animate-pulse rounded-xl border border-line bg-panel" />
          ) : !session.connected ? (
            <section className="rounded-xl border border-line bg-panel p-5">
              <h2 className="text-[16px] font-semibold">Connect your Epson printer</h2>
              <p className="mt-2 text-[13px] leading-relaxed text-muted">
                You’ll sign in on Epson’s own page and pick a printer. Epson sends back a one-time code, which the server swaps for a device token
                (OAuth 2.0 authorization code flow, <span className="font-mono">scope=device</span>). Tokens stay on the server and never reach this browser.
              </p>
              <ol className="mt-3 space-y-1 font-mono text-[12px] text-muted">
                <li>0 · GET /auth/authorize → Epson sign-in</li>
                <li>A · POST /auth/token → device + refresh token</li>
              </ol>
              {/* Full navigation: the route redirects off-site to Epson's sign-in page. */}
              <a href="/api/auth/login" className="mt-4 block w-full rounded-lg bg-accent px-4 py-2.5 text-center text-[14px] font-semibold text-accent-fg hover:opacity-90">
                Connect Epson printer
              </a>
            </section>
          ) : (
            <>
              {/* Printer card */}
              <section className="rounded-xl border border-line bg-panel p-4">
                <div className="flex items-start gap-3">
                  <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-panel-2 text-[18px]">🖨</div>
                  <div className="min-w-0 flex-1">
                    {device ? (
                      <>
                        <div className="truncate text-[14px] font-semibold">{device.productName}</div>
                        <div className="font-mono text-[12px] text-muted">S/N {device.serialNumber}</div>
                      </>
                    ) : (
                      <>
                        <div className="h-4 w-40 animate-pulse rounded bg-panel-2" />
                        <div className="mt-1.5 h-3 w-24 animate-pulse rounded bg-panel-2" />
                      </>
                    )}
                  </div>
                  {device && (
                    <span className={`flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[12px] font-medium ${device.connected ? "bg-ok-bg text-ok" : "bg-err-bg text-err"}`}>
                      <span className={`size-1.5 rounded-full ${device.connected ? "bg-ok" : "bg-err"}`} />
                      {device.connected ? "Online" : "Offline"}
                    </span>
                  )}
                </div>
                {offline && (
                  <div className="mt-3 rounded-md bg-warn-bg px-3 py-2 text-[12.5px] text-warn">
                    The printer is offline. Turn it on and check its network connection, then refresh. Printing is disabled.
                  </div>
                )}
                <div className="mt-3 flex gap-2">
                  <button type="button" onClick={loadDevice} disabled={deviceState === "loading" || busy} className="rounded-md border border-line px-2.5 py-1 text-[12px] font-medium text-muted hover:text-fg disabled:opacity-50">
                    {deviceState === "loading" ? "Checking…" : "Refresh status"}
                  </button>
                  <button type="button" onClick={disconnect} disabled={busy} className="rounded-md border border-line px-2.5 py-1 text-[12px] font-medium text-muted hover:text-err disabled:opacity-50">
                    Disconnect
                  </button>
                </div>
              </section>

              {/* File + settings */}
              <section className="space-y-4 rounded-xl border border-line bg-panel p-4">
                <FileDrop file={file} onFile={onFile} disabled={busy} />
                <Settings
                  mode={mode}
                  onModeChange={setMode}
                  cap={cap}
                  loading={!cap && !capError}
                  error={capError}
                  value={settings}
                  onChange={setSettings}
                  disabled={busy || !device}
                />

                {gate ? (
                  <div className="space-y-2 rounded-lg border border-accent/40 bg-info-bg p-3">
                    <div className="text-[12.5px] text-accent">Paused before the next call:</div>
                    <div className="font-mono text-[13px] font-semibold">{gate.label}</div>
                    <div className="flex gap-2">
                      <button type="button" onClick={() => gate.resolve(true)} className="flex-1 rounded-lg bg-accent px-3 py-2 text-[13px] font-semibold text-accent-fg hover:opacity-90">
                        Run next call →
                      </button>
                      <button type="button" onClick={() => gate.resolve(false)} className="rounded-lg border border-line bg-panel px-3 py-2 text-[13px] font-medium text-muted hover:text-fg">
                        Stop
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={print}
                    disabled={!canPrint}
                    className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-[14px] font-semibold text-accent-fg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {busy ? <><StateIcon status="running" /> Printing…</> : <>🖨 Print{stepMode ? " (step-by-step)" : ""}</>}
                  </button>
                )}
                {!file && !busy && <p className="-mt-2 text-center text-[12px] text-muted">Choose a file to enable printing.</p>}

                {run.phase === "done" && job && (
                  <JobStatus job={job} onStop={stopPolling} onRetry={() => void pollJob(job.jobId, false)} />
                )}
                {run.phase === "stopped" && <div className="rounded-lg bg-panel-2 px-3 py-2.5 text-[13px] text-muted">Walkthrough stopped. Nothing further was sent.</div>}
                {run.phase === "error" && (
                  <div className="space-y-2 rounded-lg bg-err-bg px-3 py-2.5 text-[13px] text-err">
                    <div className="font-semibold">
                      {run.failedStep ? `Failed at ${STEP_LABEL[run.failedStep] ?? run.failedStep}` : "Print failed"}
                    </div>
                    <div>{run.error}</div>
                    {run.body !== undefined && run.body !== null && (
                      <pre className="overflow-auto rounded bg-panel/60 px-2 py-1.5 font-mono text-[11.5px]">{JSON.stringify(run.body, null, 2)}</pre>
                    )}
                    {session.connected && (
                      <button type="button" onClick={print} disabled={!canPrint} className="rounded-md border border-err/40 px-2.5 py-1 text-[12px] font-medium hover:bg-panel/60 disabled:opacity-50">
                        {run.failedStep === "upload" ? "Retry from step 3" : "Try again"}
                      </button>
                    )}
                  </div>
                )}
              </section>
            </>
          )}
        </div>

        {/* RIGHT: Inspector */}
        <div className="min-h-[420px] md:sticky md:top-6 md:h-[calc(100vh-7.5rem)]">
          <Inspector log={log} onClear={() => setLog([])} onExport={exportLog} />
        </div>
      </main>
    </div>
  );
}
