// Mock transport: realistic Epson responses (PRD §10.4) with 300–800 ms delay.
// Plugs into EpsonClient as `transport`, so the client + logger code paths are identical to live.
//
// Optional: EPSON_MOCK_FAIL=createJob|upload|print|deviceOffline|paperOut|jobCanceled to demo failure states.

import type { Capability } from "./types";
import type { Transport } from "./types";

const delay = () => new Promise((r) => setTimeout(r, 300 + Math.random() * 500));

const rand = (n: number) =>
  Array.from({ length: n }, () => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[Math.floor(Math.random() * 64)]).join("");

const json = (status: number, body: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json;charset=utf-8", "x-request-id": rand(12) },
  });

const DOCUMENT_CAPABILITY: Capability = {
  colorModes: ["color", "mono"],
  resolutions: [360, 720],
  paperSizes: [
    {
      paperSize: "ps_a4",
      paperTypes: [
        { paperType: "pt_plainpaper", borderless: false, paperSources: ["rear"], printQualities: ["draft", "normal"], doubleSided: false },
        { paperType: "pt_photopaper", borderless: true, paperSources: ["rear"], printQualities: ["normal", "high"], doubleSided: false },
      ],
    },
    {
      paperSize: "ps_letter",
      paperTypes: [
        { paperType: "pt_plainpaper", borderless: false, paperSources: ["rear"], printQualities: ["draft", "normal"], doubleSided: false },
      ],
    },
    {
      paperSize: "ps_a5",
      paperTypes: [
        { paperType: "pt_plainpaper", borderless: false, paperSources: ["rear"], printQualities: ["normal"], doubleSided: false },
      ],
    },
    {
      paperSize: "ps_legal",
      paperTypes: [
        { paperType: "pt_plainpaper", borderless: false, paperSources: ["rear"], printQualities: ["normal"], doubleSided: false },
      ],
    },
  ],
};

const PHOTO_CAPABILITY: Capability = {
  colorModes: ["color", "mono"],
  resolutions: [720],
  paperSizes: [
    {
      paperSize: "ps_4x6",
      paperTypes: [
        { paperType: "pt_photopaper", borderless: true, paperSources: ["rear"], printQualities: ["normal", "high"], doubleSided: false },
        { paperType: "pt_mattepaper", borderless: true, paperSources: ["rear"], printQualities: ["normal", "high"], doubleSided: false },
      ],
    },
    {
      paperSize: "ps_5x7",
      paperTypes: [
        { paperType: "pt_photopaper", borderless: true, paperSources: ["rear"], printQualities: ["normal", "high"], doubleSided: false },
      ],
    },
    {
      paperSize: "ps_a4",
      paperTypes: [
        { paperType: "pt_photopaper", borderless: true, paperSources: ["rear"], printQualities: ["normal", "high"], doubleSided: false },
        { paperType: "pt_plainpaper", borderless: false, paperSources: ["rear"], printQualities: ["normal"], doubleSided: false },
      ],
    },
  ],
};

const tokenResponse = () =>
  json(200, { access_token: rand(43), refresh_token: rand(43), scope: "device", token_type: "Bearer", expires_in: 3600 });

const epsonError = (status: number, code: string, message: string) => json(status, { code, message });

export function createMockTransport(failStep = process.env.EPSON_MOCK_FAIL): Transport {
  return async (url, init) => {
    await delay();
    const u = new URL(url);
    const method = (init.method ?? "GET").toUpperCase();
    const path = u.pathname;

    if (path.endsWith("/auth/token") && method === "POST") return tokenResponse();

    if (u.hostname.startsWith("mock-upload")) {
      if (failStep === "upload") return epsonError(500, "upload_failed", "The file could not be stored.");
      return new Response(null, { status: 200 });
    }

    const auth = new Headers(init.headers).get("authorization") ?? "";
    if (!auth.startsWith("Bearer ")) return epsonError(401, "unauthorized", "Device token is missing or invalid.");

    if (path.endsWith("/printing/devices/info") && method === "GET") {
      return json(200, { productName: "EP ET-2400 Series", serialNumber: "X5PZ012345", connected: failStep !== "deviceOffline" });
    }

    const cap = /\/printing\/capability\/(document|photo)$/.exec(path);
    if (cap && method === "GET") return json(200, cap[1] === "photo" ? PHOTO_CAPABILITY : DOCUMENT_CAPABILITY);

    if (path.endsWith("/printing/jobs") && method === "POST") {
      if (failStep === "createJob")
        return epsonError(400, "invalid_print_settings", "The combination of print settings is not supported by this device.");
      // The jobId encodes its creation time, so job status can be simulated without
      // server state (serverless instances don't share memory).
      const jobId = String(Date.now());
      return json(201, { jobId, uploadUri: `https://mock-upload.epsonconnect.com/v1/upload?Key=${rand(32)}&jobId=${jobId}` });
    }

    if (/\/printing\/jobs\/[^/]+\/print$/.test(path) && method === "POST") {
      if (failStep === "print") return epsonError(409, "device_busy", "The printer is busy. Try again later.");
      return json(200, {});
    }

    const info = /\/printing\/jobs\/(\d+)$/.exec(path);
    if (info && method === "GET") return json(200, mockJobInfo(info[1], failStep));

    return epsonError(404, "not_found", `No mock for ${method} ${path}`);
  };
}

const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ").replace(/-/g, "/");

/** pending (≈3s) → processing (≈6s) → completed, driven by time since the job was created. */
function mockJobInfo(jobId: string, failStep?: string) {
  const created = Number(jobId);
  if (!Number.isFinite(created) || created < 1e12) return { code: "job_not_found", message: "No such job." };
  const elapsed = Date.now() - created;
  const base = { jobName: "PrintConsole", startDate: fmt(created), updateDate: fmt(Date.now()) };
  if (elapsed < 4000) return { ...base, status: "pending", statusReason: "", totalPages: 0 };
  if (failStep === "jobCanceled") return { ...base, status: "canceled", statusReason: "job_canceled_by_user", totalPages: 0 };
  if (failStep === "paperOut") return { ...base, status: "processing_stopped", statusReason: "media_empty", totalPages: 0 };
  if (elapsed < 10000) return { ...base, status: "processing", statusReason: "", totalPages: 0 };
  return { ...base, status: "completed", statusReason: "", totalPages: 1 };
}
