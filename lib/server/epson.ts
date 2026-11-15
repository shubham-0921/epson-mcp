import "server-only";
import { NextResponse } from "next/server";
import { EpsonApiError, EpsonClient, ReconnectRequiredError } from "@/lib/epson/client";
import { createMockTransport } from "@/lib/epson/mock";
import { TimeoutError, type LogSink } from "@/lib/epson/logger";
import type { ApiLogEntry } from "@/lib/epson/types";
import { epsonConfig, isMock } from "./config";

/** Collects the final state of each log entry (entries are emitted on start and on finish). */
export function collector() {
  const map = new Map<string, ApiLogEntry>();
  const sink: LogSink = (e) => map.set(e.id, e);
  return { sink, entries: () => [...map.values()] };
}

export function makeClient(onLog?: LogSink): EpsonClient {
  return new EpsonClient(epsonConfig(), {
    onLog,
    transport: isMock() ? createMockTransport() : undefined,
  });
}

export type ErrorPayload = {
  error: string;
  code: "reconnect" | "epson" | "timeout" | "validation" | "server";
  status?: number;
  body?: unknown;
};

export function toErrorPayload(err: unknown): ErrorPayload {
  if (err instanceof ReconnectRequiredError) return { error: err.message, code: "reconnect" };
  if (err instanceof EpsonApiError) return { error: err.message, code: "epson", status: err.status, body: err.body };
  if (err instanceof TimeoutError) return { error: err.message, code: "timeout" };
  return { error: err instanceof Error ? err.message : String(err), code: "server" };
}

export function errorResponse(err: unknown, log: ApiLogEntry[]) {
  const payload = toErrorPayload(err);
  const httpStatus = payload.code === "reconnect" ? 401 : payload.code === "validation" ? 400 : 502;
  return NextResponse.json({ ...payload, log }, { status: httpStatus });
}

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const ALLOWED_MIME = new Set(["application/pdf", "image/jpeg", "image/png"]);
