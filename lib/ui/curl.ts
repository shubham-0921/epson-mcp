import type { ApiLogEntry } from "@/lib/epson/types";

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Builds a cURL command from an already-redacted log entry. */
export function toCurl(e: ApiLogEntry): string {
  const parts = [`curl -X ${e.method} ${q(e.url)}`];
  for (const [k, v] of Object.entries(e.request.headers)) {
    if (k.toLowerCase() === "content-length") continue;
    parts.push(`-H ${q(`${k}: ${v}`)}`);
  }
  const body = e.request.body;
  const ctype = Object.entries(e.request.headers).find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
  if (typeof body === "string" && body.startsWith("<binary")) {
    const ext = /pdf/.test(ctype) ? "pdf" : /png/.test(ctype) ? "png" : "jpg";
    parts.push(`--data-binary @file.${ext}`);
  } else if (body && typeof body === "object" && ctype.includes("x-www-form-urlencoded")) {
    for (const [k, v] of Object.entries(body as Record<string, string>)) parts.push(`--data-urlencode ${q(`${k}=${v}`)}`);
  } else if (body !== undefined && body !== null) {
    parts.push(`-d ${q(typeof body === "string" ? body : JSON.stringify(body))}`);
  }
  return parts.join(" \\\n  ");
}
