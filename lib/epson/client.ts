// Epson Connect API 2.0 client. Pure TypeScript — no UI or framework imports,
// so it can be lifted into the MCP server unchanged. Every HTTP call goes
// through the redacting logger.

import { loggedFetch, type LogSink, type LoggedResponse } from "./logger";
import { describeBinary } from "./redact";
import type {
  Capability,
  CreateJobRequest,
  CreateJobResponse,
  DeviceInfo,
  EpsonConfig,
  PrintMode,
  TokenSet,
  TokenStore,
  Transport,
} from "./types";

export class EpsonApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: unknown,
  ) {
    super(message);
    this.name = "EpsonApiError";
  }
}

/** Thrown when tokens are missing or the refresh token was rejected. The user must reconnect. */
export class ReconnectRequiredError extends Error {
  constructor(message = "Reconnect printer") {
    super(message);
    this.name = "ReconnectRequiredError";
  }
}

const REFRESH_SKEW_MS = 60_000;

export const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
};

export function printModeForMime(mime: string): PrintMode {
  return mime === "application/pdf" ? "document" : "photo";
}

/** Half-width letters and digits only, max 32 chars; falls back to PC{timestamp}. */
export function sanitizeJobName(fileName: string | undefined, now = Date.now()): string {
  const base = (fileName ?? "").replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9]/g, "").slice(0, 32);
  return base || `PC${now}`.slice(0, 32);
}

export class EpsonClient {
  private transport: Transport;
  private timeoutMs: number;

  constructor(
    private cfg: EpsonConfig,
    opts: { transport?: Transport; onLog?: LogSink } = {},
  ) {
    this.transport = opts.transport ?? ((url, init) => fetch(url, init));
    this.onLog = opts.onLog;
    this.timeoutMs = cfg.timeoutMs ?? 30_000;
  }

  onLog?: LogSink;

  // ---------- OAuth ----------

  /** Call 0 — browser redirect target. */
  authorizeUrl(state: string): string {
    const u = new URL("/auth/authorize", this.cfg.authBase);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", this.cfg.clientId);
    u.searchParams.set("redirect_uri", this.cfg.redirectUri);
    u.searchParams.set("scope", "device");
    u.searchParams.set("state", state);
    return u.toString();
  }

  /** Call A — exchange the authorization code for device + refresh tokens. */
  async exchangeCode(code: string): Promise<TokenSet> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.cfg.redirectUri,
      client_id: this.cfg.clientId,
    }).toString();
    return this.tokenRequest("token", "A · Exchange code for tokens", body);
  }

  /** Call B — refresh the device token. Epson rotates both tokens. */
  async refresh(refreshToken: string): Promise<TokenSet> {
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }).toString();
    return this.tokenRequest("refresh", "B · Refresh device token", body);
  }

  private async tokenRequest(step: "token" | "refresh", label: string, body: string): Promise<TokenSet> {
    const basic = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64");
    const res = await loggedFetch(this.transport, this.onLog, {
      step,
      label,
      method: "POST",
      url: new URL("/auth/token", this.cfg.authBase).toString(),
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body,
      timeoutMs: this.timeoutMs,
    });
    const json = this.expectOk(res, label) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      scope?: string;
    };
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
      scope: json.scope,
    };
  }

  // ---------- Token management ----------

  /**
   * Run `fn` with a fresh device token. Refreshes if it expires within 60s,
   * and on a 401 refreshes once and retries once.
   */
  async withToken<T>(store: TokenStore, fn: (accessToken: string) => Promise<T>): Promise<T> {
    let tokens = await store.get();
    if (!tokens) throw new ReconnectRequiredError("Not connected");
    if (tokens.expiresAt - Date.now() < REFRESH_SKEW_MS) tokens = await this.refreshInto(store, tokens);
    try {
      return await fn(tokens.accessToken);
    } catch (err) {
      if (err instanceof EpsonApiError && err.status === 401) {
        tokens = await this.refreshInto(store, tokens);
        return fn(tokens.accessToken);
      }
      throw err;
    }
  }

  private async refreshInto(store: TokenStore, tokens: TokenSet): Promise<TokenSet> {
    try {
      const next = await this.refresh(tokens.refreshToken);
      await store.set(next);
      return next;
    } catch (err) {
      if (err instanceof EpsonApiError && (err.status === 400 || err.status === 401)) {
        await store.set(null);
        throw new ReconnectRequiredError();
      }
      throw err;
    }
  }

  // ---------- Printing ----------

  private apiHeaders(accessToken: string, extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${accessToken}`, "x-api-key": this.cfg.apiKey, ...extra };
  }

  private apiUrl(path: string): string {
    return `${this.cfg.apiBase.replace(/\/$/, "")}${path}`;
  }

  /** Call 1 */
  async getDeviceInfo(accessToken: string): Promise<DeviceInfo> {
    const label = "1 · Get device information";
    const res = await loggedFetch(this.transport, this.onLog, {
      step: "deviceInfo",
      label,
      method: "GET",
      url: this.apiUrl("/printing/devices/info"),
      headers: this.apiHeaders(accessToken),
      timeoutMs: this.timeoutMs,
    });
    return this.expectOk(res, label) as DeviceInfo;
  }

  /** Call 2 */
  async getCapability(accessToken: string, mode: PrintMode): Promise<Capability> {
    const label = `2 · Get ${mode} capabilities`;
    const res = await loggedFetch(this.transport, this.onLog, {
      step: "capability",
      label,
      method: "GET",
      url: this.apiUrl(`/printing/capability/${mode}`),
      headers: this.apiHeaders(accessToken),
      timeoutMs: this.timeoutMs,
    });
    return this.expectOk(res, label) as Capability;
  }

  /** Call 3 */
  async createJob(accessToken: string, job: CreateJobRequest): Promise<CreateJobResponse> {
    const label = "3 · Create print job";
    const res = await loggedFetch(this.transport, this.onLog, {
      step: "createJob",
      label,
      method: "POST",
      url: this.apiUrl("/printing/jobs"),
      headers: this.apiHeaders(accessToken, { "Content-Type": "application/json" }),
      body: JSON.stringify(job),
      displayBody: job,
      timeoutMs: this.timeoutMs,
    });
    return this.expectOk(res, label) as CreateJobResponse;
  }

  /** Call 4 — uploadUri already carries a query string, so append &File=1.<ext>. */
  async uploadFile(uploadUri: string, bytes: Uint8Array, mime: string): Promise<void> {
    const label = "4 · Upload file";
    const ext = Object.entries(MIME_BY_EXT).find(([, m]) => m === mime)?.[0] ?? "pdf";
    const sep = uploadUri.includes("?") ? "&" : "?";
    const res = await loggedFetch(this.transport, this.onLog, {
      step: "upload",
      label,
      method: "POST",
      url: `${uploadUri}${sep}File=1.${ext}`,
      headers: { "Content-Type": mime, "Content-Length": String(bytes.byteLength) },
      body: bytes as unknown as BodyInit,
      displayBody: describeBinary(bytes.byteLength, mime),
      timeoutMs: this.timeoutMs,
    });
    this.expectOk(res, label);
  }

  /** Call 5 */
  async executePrint(accessToken: string, jobId: string): Promise<void> {
    const label = "5 · Execute print";
    const res = await loggedFetch(this.transport, this.onLog, {
      step: "print",
      label,
      method: "POST",
      url: this.apiUrl(`/printing/jobs/${encodeURIComponent(jobId)}/print`),
      headers: this.apiHeaders(accessToken),
      timeoutMs: this.timeoutMs,
    });
    this.expectOk(res, label);
  }

  private expectOk(res: LoggedResponse, label: string): unknown {
    if (!res.ok) throw new EpsonApiError(`${label} failed with HTTP ${res.status}`, res.status, res.body);
    return res.body;
  }
}
