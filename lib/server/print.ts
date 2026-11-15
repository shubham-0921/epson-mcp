import "server-only";
import { sealData, unsealData } from "iron-session";
import { sanitizeJobName } from "@/lib/epson/client";
import type { CreateJobRequest, PrintMode, PrintSettings } from "@/lib/epson/types";
import { ALLOWED_MIME, MAX_UPLOAD_BYTES } from "./epson";
import { sessionSecret } from "./config";

export class ValidationError extends Error {}

export function validateFile(file: unknown): File {
  if (!(file instanceof File)) throw new ValidationError("No file was uploaded.");
  if (!ALLOWED_MIME.has(file.type)) throw new ValidationError(`Unsupported file type "${file.type || "unknown"}". Use PDF, JPEG or PNG.`);
  if (file.size > MAX_UPLOAD_BYTES) throw new ValidationError("File is larger than 20 MB.");
  if (file.size === 0) throw new ValidationError("File is empty.");
  return file;
}

export function buildJob(input: { printMode?: unknown; settings?: unknown; fileName?: string }): CreateJobRequest {
  const printMode: PrintMode = input.printMode === "photo" ? "photo" : "document";
  const s = (input.settings ?? {}) as Partial<PrintSettings>;
  for (const k of ["paperSize", "paperType", "printQuality", "paperSource", "colorMode"] as const) {
    if (typeof s[k] !== "string" || !s[k]) throw new ValidationError(`Missing print setting: ${k}`);
  }
  const copies = Number(s.copies ?? 1);
  if (!Number.isInteger(copies) || copies < 1 || copies > 10) throw new ValidationError("Copies must be 1–10.");
  return {
    jobName: sanitizeJobName(input.fileName),
    printMode,
    printSettings: {
      paperSize: s.paperSize!,
      paperType: s.paperType!,
      borderless: !!s.borderless,
      printQuality: s.printQuality!,
      paperSource: s.paperSource!,
      colorMode: s.colorMode!,
      copies,
    },
  };
}

export function parseJson(value: FormDataEntryValue | null): unknown {
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value);
  } catch {
    throw new ValidationError("Invalid settings JSON.");
  }
}

/** Step mode: the uploadUri never reaches the browser in the clear — it travels as a sealed ticket. */
type Ticket = { jobId: string; uploadUri: string };
export const sealTicket = (t: Ticket) => sealData(t, { password: sessionSecret(), ttl: 60 * 30 });
export async function unsealTicket(ticket: unknown): Promise<Ticket> {
  if (typeof ticket !== "string") throw new ValidationError("Missing job ticket.");
  const t = await unsealData<Ticket>(ticket, { password: sessionSecret() });
  if (!t?.uploadUri) throw new ValidationError("Job ticket is invalid or expired. Create the job again.");
  return t;
}
