// Wraps every Epson HTTP request: records request, response and timing with secrets redacted.

import { redactBody, redactHeaders, redactUrl } from "./redact";
import type { ApiLogEntry, ApiStep, HttpMethod, Transport } from "./types";

export type LogSink = (entry: ApiLogEntry) => void;

export type LoggedRequest = {
  step: ApiStep;
  label: string;
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  body?: BodyInit;
  /** What the inspector shows instead of the real body (e.g. "<binary: 1.2 MB application/pdf>"). */
  displayBody?: unknown;
  timeoutMs: number;
};

export type LoggedResponse = { status: number; ok: boolean; headers: Record<string, string>; body: unknown };

let counter = 0;
const newId = () => `${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export class TimeoutError extends Error {}

export async function loggedFetch(
  transport: Transport,
  sink: LogSink | undefined,
  req: LoggedRequest,
): Promise<LoggedResponse> {
  const started = Date.now();
  const entry: ApiLogEntry = {
    id: newId(),
    step: req.step,
    label: req.label,
    method: req.method,
    url: redactUrl(req.url),
    request: {
      headers: redactHeaders(req.headers),
      body: req.displayBody !== undefined ? req.displayBody : redactBody(req.body ?? undefined),
    },
    status: "running",
    startedAt: new Date(started).toISOString(),
  };
  const emit = () => sink?.({ ...entry });
  emit();

  try {
    const res = await transport(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: AbortSignal.timeout(req.timeoutMs),
    });
    const text = await res.text();
    let body: unknown = text;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        /* keep text */
      }
    } else body = undefined;
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k] = v));

    entry.response = { status: res.status, headers: redactHeaders(headers), body: redactBody(body) };
    entry.durationMs = Date.now() - started;
    entry.status = res.ok ? "success" : "error";
    if (!res.ok) entry.error = `HTTP ${res.status}`;
    emit();
    return { status: res.status, ok: res.ok, headers, body };
  } catch (err) {
    entry.durationMs = Date.now() - started;
    entry.status = "error";
    const isTimeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    entry.error = isTimeout
      ? `Timed out after ${Math.round(req.timeoutMs / 1000)}s`
      : err instanceof Error
        ? err.message
        : String(err);
    emit();
    throw isTimeout ? new TimeoutError(entry.error) : err;
  }
}
