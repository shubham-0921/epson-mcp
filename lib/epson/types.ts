// Shared Epson Connect API 2.0 types. Pure TypeScript — no UI or framework imports.

export type ApiStep =
  | "authorize"
  | "token"
  | "refresh"
  | "deviceInfo"
  | "capability"
  | "createJob"
  | "upload"
  | "print"
  | "jobInfo";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export type ApiLogEntry = {
  id: string;
  step: ApiStep;
  label: string; // "3 · Create print job"
  method: HttpMethod;
  url: string; // secrets redacted from query too
  request: { headers: Record<string, string>; body?: unknown };
  response?: { status: number; headers: Record<string, string>; body?: unknown };
  status: "pending" | "running" | "success" | "error";
  startedAt: string; // ISO
  durationMs?: number;
  error?: string;
};

export type TokenSet = {
  accessToken: string; // the "device token"
  refreshToken: string;
  expiresAt: number; // epoch ms
  scope?: string;
};

export type DeviceInfo = {
  productName: string;
  serialNumber: string;
  connected: boolean;
};

export type PrintMode = "document" | "photo";

export type CapabilityPaperType = {
  paperType: string;
  borderless: boolean;
  paperSources: string[];
  printQualities: string[];
  doubleSided: boolean;
};

export type Capability = {
  colorModes: string[];
  resolutions: number[];
  paperSizes: { paperSize: string; paperTypes: CapabilityPaperType[] }[];
};

export type PrintSettings = {
  paperSize: string;
  paperType: string;
  borderless: boolean;
  printQuality: string;
  paperSource: string;
  colorMode: string;
  copies: number;
};

export type CreateJobRequest = {
  jobName: string;
  printMode: PrintMode;
  printSettings: PrintSettings;
};

export type CreateJobResponse = { jobId: string; uploadUri: string };

/** Job status values from the Epson Connect spec (Appendix E), normalized to snake_case. */
export type JobStatus = "pending" | "processing" | "processing_stopped" | "canceled" | "completed" | "unknown";

export type JobInfo = {
  status: JobStatus;
  rawStatus: string; // exactly what Epson returned
  statusReason: string; // e.g. media_jam, media_empty, marker_supply_empty, attention_required
  jobName?: string;
  totalPages?: number;
  startDate?: string;
  updateDate?: string;
  /** canceled or completed — stop polling. */
  final: boolean;
  /** Completed or canceled abnormally, e.g. completed + attention_required. */
  failed: boolean;
};

export type EpsonConfig = {
  clientId: string;
  clientSecret: string;
  apiKey: string;
  redirectUri: string;
  authBase: string; // https://auth.epsonconnect.com
  apiBase: string; // https://api.epsonconnect.com/api/2
  timeoutMs?: number; // default 30s
  /** Path template for Get print job information. Default "/printing/jobs/{jobId}". */
  jobInfoPath?: string;
};

/** Minimal fetch signature so a mock transport can be injected. */
export type Transport = (url: string, init: RequestInit) => Promise<Response>;

/** Where tokens live. Server session for the web app; a file/keychain for the MCP server. */
export interface TokenStore {
  get(): TokenSet | null | Promise<TokenSet | null>;
  set(tokens: TokenSet | null): void | Promise<void>;
}
