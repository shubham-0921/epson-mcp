"use client";

import type { JobInfo } from "@/lib/epson/types";
import { JOB_REASONS as REASONS } from "@/lib/epson/job-text";
import { StateIcon } from "./Inspector";

export type JobTracking = {
  jobId: string;
  phase: "waiting" | "polling" | "final" | "timeout" | "error" | "stopped";
  info: JobInfo | null;
  checks: number;
  error?: string;
};

function describe(info: JobInfo | null): { title: string; detail?: string; tone: "ok" | "err" | "warn" | "info" } {
  if (!info) return { title: "Checking job status…", tone: "info" };
  const reason = info.statusReason ? (REASONS[info.statusReason] ?? info.statusReason) : undefined;
  switch (info.status) {
    case "pending":
      return { title: "Waiting to print", detail: "The job is queued at Epson Connect for your printer.", tone: "info" };
    case "processing":
      return { title: "Printing…", tone: "info" };
    case "processing_stopped":
      return { title: "Printing paused", detail: reason, tone: "warn" };
    case "canceled":
      return { title: "Canceled", detail: reason, tone: "err" };
    case "completed":
      return info.statusReason
        ? { title: "Finished with an error", detail: reason, tone: "err" }
        : { title: "Printed ✓", detail: info.totalPages ? `${info.totalPages} page${info.totalPages === 1 ? "" : "s"} printed.` : undefined, tone: "ok" };
    default:
      return { title: `Status: ${info.rawStatus || "unknown"}`, detail: "Unrecognized status — see the raw response in the inspector.", tone: "warn" };
  }
}

const STAGES = [
  { key: "pending", label: "Queued" },
  { key: "processing", label: "Printing" },
  { key: "completed", label: "Printed" },
] as const;

function stageIndex(info: JobInfo | null) {
  if (!info) return -1;
  if (info.status === "pending") return 0;
  if (info.status === "processing" || info.status === "processing_stopped") return 1;
  if (info.status === "completed") return 2;
  return -1;
}

const TONE: Record<string, string> = {
  ok: "bg-ok-bg text-ok",
  err: "bg-err-bg text-err",
  warn: "bg-warn-bg text-warn",
  info: "bg-panel-2 text-fg",
};

export default function JobStatus({ job, onStop, onRetry }: { job: JobTracking; onStop: () => void; onRetry: () => void }) {
  const d = describe(job.info);
  const idx = stageIndex(job.info);
  const live = job.phase === "polling";
  const failedOrCanceled = job.info?.failed;

  return (
    <div className="space-y-3 rounded-lg border border-line p-3">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-[13px] font-semibold text-ok">Sent to the printer ✓</div>
        <div className="font-mono text-[12px] text-muted">Job {job.jobId}</div>
      </div>

      {/* stage track */}
      <ol className="flex items-center gap-1.5">
        {STAGES.map((s, i) => {
          const reached = idx >= i;
          const current = idx === i && !job.info?.final;
          const bad = failedOrCanceled && i === Math.max(idx, 0);
          return (
            <li key={s.key} className="flex flex-1 items-center gap-1.5">
              <span className="flex items-center gap-1.5">
                {current && live ? (
                  <StateIcon status="running" />
                ) : bad ? (
                  <StateIcon status="error" />
                ) : (
                  <StateIcon status={reached ? "success" : "pending"} />
                )}
                <span className={`text-[12px] ${reached ? "font-medium" : "text-muted"}`}>{s.label}</span>
              </span>
              {i < STAGES.length - 1 && <span className={`h-px flex-1 ${idx > i ? "bg-ok" : "bg-line"}`} />}
            </li>
          );
        })}
      </ol>

      <div className={`rounded-md px-3 py-2 text-[13px] ${TONE[d.tone]}`}>
        <div className="font-semibold">{job.phase === "waiting" ? "Paused before checking job status" : d.title}</div>
        {d.detail && job.phase !== "waiting" && <div className="mt-0.5 text-[12.5px] opacity-90">{d.detail}</div>}
        {job.info?.rawStatus && (
          <div className="mt-1 font-mono text-[11px] opacity-70">
            status={job.info.rawStatus}
            {job.info.statusReason ? ` · reason=${job.info.statusReason}` : ""}
          </div>
        )}
      </div>

      {job.phase === "error" && (
        <div className="rounded-md bg-err-bg px-3 py-2 text-[12.5px] text-err">
          Couldn’t get the job status: {job.error}
          <div className="mt-1 opacity-80">
            If Epson returned 404, the 2.0 path may differ from <span className="font-mono">/printing/jobs/{"{jobId}"}</span>. Set{" "}
            <span className="font-mono">EPSON_JOB_INFO_PATH</span> to the path from Epson’s API reference.
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 text-[12px] text-muted">
        <span>
          {job.checks > 0 ? `Checked ${job.checks} time${job.checks === 1 ? "" : "s"}` : "Not checked yet"}
          {live ? " · checking automatically" : job.phase === "timeout" ? " · stopped after 3 minutes" : job.phase === "stopped" ? " · stopped" : ""}
        </span>
        {live ? (
          <button type="button" onClick={onStop} className="ml-auto rounded-md border border-line px-2.5 py-1 font-medium hover:text-fg">
            Stop checking
          </button>
        ) : job.phase !== "final" && job.phase !== "waiting" ? (
          <button type="button" onClick={onRetry} className="ml-auto rounded-md border border-line px-2.5 py-1 font-medium hover:text-fg">
            Check again
          </button>
        ) : null}
      </div>
    </div>
  );
}
