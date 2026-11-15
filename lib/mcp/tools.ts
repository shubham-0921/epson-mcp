// The Epson Print MCP tools. Transport-agnostic: registered on an McpServer by the
// stdio entry today and by the remote /api/mcp route in Phase 2.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { EpsonApiError, EpsonClient, ReconnectRequiredError, sanitizeJobName } from "../epson/client";
import { TimeoutError, type LogSink } from "../epson/logger";
import { colorLabel, paperSizeLabel, paperTypeLabel, qualityLabel, sourceLabel } from "../epson/labels";
import { describeSettings, resolveSettings, SettingsError, settingsFromRequest } from "../epson/settings";
import { describeJob } from "../epson/job-text";
import type { JobInfo, PrintMode, TokenStore } from "../epson/types";
import { prepareSource, SourceError } from "./sources";

export type ToolContext = {
  /** A client whose calls are logged (redacted) through `onLog`. */
  makeClient: (onLog?: LogSink) => EpsonClient;
  store: TokenStore;
  onLog?: LogSink;
  /** Message shown when the user must (re)connect their printer. */
  reconnectHint: string;
  /** Called right before a job is created; return a message to refuse (e.g. rate limit). */
  beforePrint?: () => Promise<string | null>;
};

export const LIMITS = { maxCopies: 10, maxPagesWithoutConfirm: 30, maxWaitSeconds: 50 };

// ---------- helpers ----------

const text = (t: string) => [{ type: "text" as const, text: t }];

function ok<T extends Record<string, unknown>>(summary: string, data: T): CallToolResult {
  return { content: text(summary), structuredContent: data };
}

function fail(message: string): CallToolResult {
  return { isError: true, content: text(message) };
}

// Match by class OR name: a loader can create two copies of a module (e.g. tsx loading
// it as ESM and as CJS), and then `instanceof` fails across the copies.
const is = <T,>(err: unknown, cls: abstract new (...a: never[]) => T, name: string): err is T =>
  err instanceof cls || (err instanceof Error && err.name === name);

function errorResult(err: unknown, ctx: ToolContext): CallToolResult {
  if (is(err, ReconnectRequiredError, "ReconnectRequiredError")) return fail(`The printer isn't connected. ${ctx.reconnectHint}`);
  if (is(err, SettingsError, "SettingsError") || is(err, SourceError, "SourceError")) return fail(err.message);
  if (is(err, TimeoutError, "TimeoutError")) return fail(`Epson didn't answer in time: ${err.message}. Try again in a moment.`);
  if (is(err, EpsonApiError, "EpsonApiError")) {
    const body = err.body === undefined ? "" : `\nEpson's response: ${typeof err.body === "string" ? err.body : JSON.stringify(err.body)}`;
    return fail(`${err.message}.${body}`);
  }
  return fail(err instanceof Error ? err.message : String(err));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function jobView(jobId: string, info: JobInfo) {
  const d = describeJob(info);
  return {
    jobId,
    status: info.status,
    statusReason: info.statusReason || null,
    description: d.detail ? `${d.title}. ${d.detail}` : d.title,
    final: info.final,
    failed: info.failed,
    totalPages: info.totalPages ?? null,
    updatedAt: info.updateDate ?? null,
  };
}

// ---------- schemas ----------

const printerOut = { productName: z.string(), serialNumber: z.string(), online: z.boolean() };

const optionsOut = {
  mode: z.enum(["document", "photo"]),
  paperSizes: z.array(
    z.object({
      name: z.string(),
      code: z.string(),
      paperTypes: z.array(
        z.object({
          name: z.string(),
          code: z.string(),
          qualities: z.array(z.string()),
          sources: z.array(z.string()),
          borderless: z.boolean(),
        }),
      ),
    }),
  ),
  colorModes: z.array(z.string()),
  defaults: z.object({
    paperSize: z.string(),
    paperType: z.string(),
    quality: z.string(),
    color: z.string(),
    source: z.string(),
    borderless: z.boolean(),
    copies: z.number(),
  }),
};

const jobOut = {
  jobId: z.string(),
  status: z.enum(["pending", "processing", "processing_stopped", "canceled", "completed", "unknown"]),
  statusReason: z.string().nullable(),
  description: z.string(),
  final: z.boolean(),
  failed: z.boolean(),
  totalPages: z.number().nullable(),
  updatedAt: z.string().nullable(),
};

const sourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("markdown"),
    markdown: z.string().min(1).describe("The content to print, as Markdown. Headings, lists, task lists, tables, quotes and code blocks are supported."),
    title: z.string().max(80).optional().describe("Document title, used as the file and job name."),
  }),
  z.object({
    type: z.literal("base64"),
    data: z.string().min(1).describe("File bytes, base64-encoded. At most 1 MB decoded."),
    mimeType: z.enum(["application/pdf", "image/jpeg", "image/png"]),
    fileName: z.string().max(120).optional(),
  }),
]);

// ---------- registration ----------

export function registerEpsonTools(server: McpServer, ctx: ToolContext) {
  const client = () => ctx.makeClient(ctx.onLog);

  server.registerTool(
    "get_printer_status",
    {
      title: "Get printer status",
      description: "Shows which Epson printer is connected and whether it is online. Call this before printing if the user asks about the printer.",
      inputSchema: {},
      outputSchema: printerOut,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        const c = client();
        const d = await c.withToken(ctx.store, (t) => c.getDeviceInfo(t));
        return ok(`${d.productName} (serial ${d.serialNumber}) is ${d.connected ? "online" : "offline"}.`, {
          productName: d.productName,
          serialNumber: d.serialNumber,
          online: d.connected,
        });
      } catch (err) {
        return errorResult(err, ctx);
      }
    },
  );

  server.registerTool(
    "get_print_options",
    {
      title: "Get print options",
      description:
        "Lists the paper sizes, paper types, print qualities, colour modes and paper sources the connected printer supports, and the default combination. Use `document` for PDFs and text, `photo` for images.",
      inputSchema: { mode: z.enum(["document", "photo"]).default("document").describe("Print mode: document or photo.") },
      outputSchema: optionsOut,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ mode }) => {
      try {
        const c = client();
        const cap = await c.withToken(ctx.store, (t) => c.getCapability(t, mode));
        const defaults = describeSettings(resolveSettings(cap));
        const data = {
          mode,
          paperSizes: cap.paperSizes.map((p) => ({
            name: paperSizeLabel(p.paperSize),
            code: p.paperSize,
            paperTypes: p.paperTypes.map((t) => ({
              name: paperTypeLabel(t.paperType),
              code: t.paperType,
              qualities: t.printQualities.map(qualityLabel),
              sources: t.paperSources.map(sourceLabel),
              borderless: t.borderless,
            })),
          })),
          colorModes: cap.colorModes.map(colorLabel),
          defaults,
        };
        const summary = [
          `${mode} printing supports: ${data.paperSizes.map((p) => `${p.name} (${p.paperTypes.map((t) => t.name).join(", ")})`).join("; ")}.`,
          `Colour: ${data.colorModes.join(", ")}.`,
          `Default: ${defaults.paperSize}, ${defaults.paperType}, ${defaults.quality} quality, ${defaults.color}.`,
        ].join(" ");
        return ok(summary, data);
      } catch (err) {
        return errorResult(err, ctx);
      }
    },
  );

  server.registerTool(
    "print_document",
    {
      title: "Print a document",
      description: [
        "Prints on the user's connected Epson printer. Uses real paper and ink, so confirm with the user before calling.",
        "Pass `source` as Markdown you write (for lists, letters, notes, summaries) or as base64 bytes of a PDF, JPEG or PNG (max 1 MB).",
        "All settings are optional and take readable values such as \"A4\", \"Letter\", \"plain\", \"photo paper\", \"high\", \"black and white\".",
        `Unset settings use the printer's defaults. Jobs over ${LIMITS.maxPagesWithoutConfirm} printed pages (pages × copies) need confirm_large: true, which you should only set after the user agrees.`,
        "Returns a job ID; use get_print_job_status to follow it.",
      ].join(" "),
      inputSchema: {
        source: sourceSchema,
        mode: z.enum(["document", "photo"]).optional().describe("Defaults to document for PDFs and Markdown, photo for images."),
        paper_size: z.string().optional().describe('e.g. "A4", "Letter", "4x6"'),
        paper_type: z.string().optional().describe('e.g. "plain", "photo paper", "matte"'),
        quality: z.string().optional().describe('e.g. "draft", "normal", "high"'),
        color: z.string().optional().describe('"color" or "black and white"'),
        paper_source: z.string().optional().describe('Paper tray, e.g. "rear"'),
        borderless: z.boolean().optional(),
        copies: z.number().int().min(1).max(LIMITS.maxCopies).optional().describe("1–10, default 1"),
        confirm_large: z.boolean().optional().describe(`Set only after the user agrees to print more than ${LIMITS.maxPagesWithoutConfirm} pages.`),
      },
      outputSchema: {
        jobId: z.string(),
        fileName: z.string(),
        pages: z.number(),
        copies: z.number(),
        settings: optionsOut.defaults,
        status: jobOut.status,
        description: z.string(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const c = client();
        return await c.withToken(ctx.store, async (token) => {
          const device = await c.getDeviceInfo(token);
          if (!device.connected) return fail(`${device.productName} is offline. Ask the user to turn it on and check its network connection, then try again.`);

          const mode: PrintMode =
            args.mode ?? (args.source.type === "base64" && args.source.mimeType !== "application/pdf" ? "photo" : "document");
          const cap = await c.getCapability(token, mode);
          const settings = settingsFromRequest(cap, {
            paperSize: args.paper_size,
            paperType: args.paper_type,
            quality: args.quality,
            color: args.color,
            source: args.paper_source,
            borderless: args.borderless,
            copies: args.copies,
          });

          const file = await prepareSource(args.source, settings.paperSize);
          const printed = file.pages * settings.copies;
          if (printed > LIMITS.maxPagesWithoutConfirm && !args.confirm_large) {
            return fail(
              `This would print ${printed} pages (${file.pages} page${file.pages === 1 ? "" : "s"} × ${settings.copies} cop${settings.copies === 1 ? "y" : "ies"}). ` +
                `Ask the user to confirm, then call again with confirm_large: true.`,
            );
          }

          const refused = await ctx.beforePrint?.();
          if (refused) return fail(refused);

          const jobName = sanitizeJobName(args.source.type === "markdown" ? args.source.title || "Document" : file.fileName);
          const { jobId, uploadUri } = await c.createJob(token, { jobName, printMode: mode, printSettings: settings });
          await c.uploadFile(uploadUri, file.bytes, file.mime);
          await c.executePrint(token, jobId);

          // One status check so the answer says more than "sent". Best effort.
          let status: JobInfo["status"] = "pending";
          let description = "Sent to the printer.";
          try {
            const info = await c.getJobInfo(token, jobId);
            status = info.status;
            description = jobView(jobId, info).description;
          } catch {
            /* ignore — the job was still sent */
          }

          const used = describeSettings(settings);
          return ok(
            `Sent "${file.fileName}" to ${device.productName}: job ${jobId}, ${file.pages} page${file.pages === 1 ? "" : "s"} × ${used.copies}, ` +
              `${used.paperSize} ${used.paperType.toLowerCase()}, ${used.quality.toLowerCase()} quality, ${used.color.toLowerCase()}. Status: ${description}`,
            { jobId, fileName: file.fileName, pages: file.pages, copies: used.copies, settings: used, status, description },
          );
        });
      } catch (err) {
        return errorResult(err, ctx);
      }
    },
  );

  server.registerTool(
    "get_print_job_status",
    {
      title: "Get print job status",
      description: `Reports where a print job is: waiting, printing, paused (with the reason, e.g. out of paper), printed or canceled. Set wait_seconds (up to ${LIMITS.maxWaitSeconds}) to wait for the job to finish; call again if it is still going.`,
      inputSchema: {
        job_id: z.string().min(1).describe("The job ID returned by print_document."),
        wait_seconds: z.number().int().min(0).max(LIMITS.maxWaitSeconds).default(0).describe("How long to wait for a final status. 0 = check once."),
      },
      outputSchema: jobOut,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ job_id, wait_seconds }, extra) => {
      try {
        const c = client();
        const progressToken = extra._meta?.progressToken;
        const deadline = Date.now() + wait_seconds * 1000;
        let attempt = 0;
        for (;;) {
          attempt++;
          const info = await c.withToken(ctx.store, (t) => c.getJobInfo(t, job_id, attempt));
          const view = jobView(job_id, info);
          if (progressToken !== undefined) {
            await extra.sendNotification({
              method: "notifications/progress",
              params: { progressToken, progress: attempt, message: view.description },
            });
          }
          if (info.final || Date.now() + 3000 > deadline) {
            const still = !info.final && wait_seconds > 0 ? " Still in progress — call again to keep waiting." : "";
            return ok(`Job ${job_id}: ${view.description}${still}`, view);
          }
          await sleep(Math.min(3000, Math.max(0, deadline - Date.now())));
        }
      } catch (err) {
        return errorResult(err, ctx);
      }
    },
  );
}
