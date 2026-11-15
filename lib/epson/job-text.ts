// Plain-language wording for job statuses (Epson spec, Appendix E). Shared by the UI and the MCP tools.

import type { JobInfo } from "./types";

export const JOB_REASONS: Record<string, string> = {
  media_jam: "Paper jam — clear it on the printer and printing will continue.",
  media_empty: "Out of paper — load paper and printing will continue.",
  marker_supply_empty: "Out of ink — replace or refill the ink.",
  attention_required: "The printer needs attention. Check its screen.",
  job_canceled_by_user: "Canceled by the user (Epson Connect user page or Cancel API).",
  job_canceled_by_out_of_storage_period: "Canceled because the job wasn’t printed within 72 hours.",
  complete_with_warning: "Finished, but some files couldn’t be printed.",
};

export function describeJob(info: JobInfo): { title: string; detail?: string } {
  const reason = info.statusReason ? (JOB_REASONS[info.statusReason] ?? info.statusReason) : undefined;
  switch (info.status) {
    case "pending":
      return { title: "Waiting to print", detail: "The job is queued at Epson Connect for the printer." };
    case "processing":
      return { title: "Printing" };
    case "processing_stopped":
      return { title: "Printing paused", detail: reason };
    case "canceled":
      return { title: "Canceled", detail: reason };
    case "completed":
      return info.statusReason
        ? { title: "Finished with an error", detail: reason }
        : { title: "Printed", detail: info.totalPages ? `${info.totalPages} page${info.totalPages === 1 ? "" : "s"} printed.` : undefined };
    default:
      return { title: `Unrecognized status: ${info.rawStatus || "unknown"}` };
  }
}
