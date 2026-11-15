// HTML → PDF with headless Chromium, sized to the chosen paper.
//
// Templates should NOT set `@page { size }`: the server sets it from the print
// settings so the PDF always matches the paper in the printer. Templates may set
// `@page { margin }` (default 12 mm; 0 when borderless).
//
// Safety: JavaScript is off. Only data: URLs and https URLs whose host resolves to a
// public address may load (images, fonts, stylesheets); everything else is blocked.

import { lookup } from "node:dns/promises";
import { existsSync } from "node:fs";
import { isIP } from "node:net";
import puppeteer, { type Browser, type HTTPRequest } from "puppeteer-core";

export const MAX_HTML_CHARS = 2_000_000;
const RENDER_TIMEOUT_MS = 20_000;
const MAX_SUBRESOURCES = 60;

/** Paper size in CSS units for each Epson paper code that a document can be rendered on. */
export const PAPER_CSS: Record<string, { w: string; h: string }> = {
  ps_a3: { w: "297mm", h: "420mm" },
  ps_a4: { w: "210mm", h: "297mm" },
  ps_a5: { w: "148mm", h: "210mm" },
  ps_a6: { w: "105mm", h: "148mm" },
  ps_b4: { w: "257mm", h: "364mm" },
  ps_b5: { w: "182mm", h: "257mm" },
  ps_letter: { w: "8.5in", h: "11in" },
  ps_legal: { w: "8.5in", h: "14in" },
  ps_executive: { w: "7.25in", h: "10.5in" },
  ps_4x6: { w: "4in", h: "6in" },
  ps_5x7: { w: "5in", h: "7in" },
  ps_8x10: { w: "8in", h: "10in" },
  ps_l: { w: "89mm", h: "127mm" },
  ps_2l: { w: "127mm", h: "178mm" },
  ps_hagaki: { w: "100mm", h: "148mm" },
  ps_kg: { w: "4in", h: "6in" },
  ps_envelope10: { w: "9.5in", h: "4.125in" },
  ps_envelopedl: { w: "220mm", h: "110mm" },
};

export class HtmlRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceError"; // reported to Claude like any other bad source
  }
}

// ---------- network guard ----------

function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::") return true;
    if (v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80")) return true;
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isPrivateAddress(mapped[1]) : false;
  }
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224
  );
}

const hostCache = new Map<string, boolean>();

async function isPublicHost(host: string): Promise<boolean> {
  const h = host.replace(/^\[|\]$/g, "");
  if (hostCache.has(h)) return hostCache.get(h)!;
  let ok = false;
  try {
    if (isIP(h)) ok = !isPrivateAddress(h);
    else if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) ok = false;
    else ok = (await lookup(h, { all: true })).every((r) => !isPrivateAddress(r.address));
  } catch {
    ok = false;
  }
  hostCache.set(h, ok);
  return ok;
}

// ---------- browser ----------

async function launch(): Promise<Browser> {
  const onServerless = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
  if (onServerless) {
    const chromium = (await import("@sparticuz/chromium")).default;
    return puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
      defaultViewport: { width: 1240, height: 1754 },
    });
  }
  const local =
    process.env.CHROME_PATH ||
    [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    ].find((p) => existsSync(p));
  if (!local) throw new HtmlRenderError("No Chrome found to render HTML. Install Google Chrome or set CHROME_PATH.");
  return puppeteer.launch({ executablePath: local, headless: true, args: ["--no-sandbox", "--disable-gpu"] });
}

// ---------- document assembly ----------

const BASE_CSS = `
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;font:11pt/1.45 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#111}
img{max-width:100%}
table{border-collapse:collapse}
`;

/** Wraps a fragment in a document, and pins the page size to the paper. */
export function assembleHtml(html: string, paper: { w: string; h: string }, opts: { borderless: boolean; title?: string }): string {
  const margin = opts.borderless ? "0" : "12mm";
  // Margin goes first so a template's own @page margin wins; size goes last so it can't be overridden.
  const head = `<meta charset="utf-8"><style>@page{margin:${margin}}${BASE_CSS}</style>`;
  const tail = `<style>@page{size:${paper.w} ${paper.h};${opts.borderless ? "margin:0;" : ""}}</style>`;
  const isDocument = /<html[\s>]/i.test(html) || /<!doctype/i.test(html);
  if (!isDocument) {
    const title = opts.title ? `<title>${opts.title.replace(/[<&]/g, "")}</title>` : "";
    return `<!doctype html><html><head>${head}${title}</head><body>${html}${tail}</body></html>`;
  }
  let doc = /<head[^>]*>/i.test(html) ? html.replace(/<head([^>]*)>/i, `<head$1>${head}`) : html.replace(/<html([^>]*)>/i, `<html$1><head>${head}</head>`);
  doc = /<\/body>/i.test(doc) ? doc.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${tail}</body>`) : doc + tail;
  return doc;
}

export type HtmlRenderResult = { bytes: Uint8Array; blocked: string[] };

export async function htmlToPdf(html: string, paperSize: string, opts: { borderless?: boolean; title?: string } = {}): Promise<HtmlRenderResult> {
  if (html.length > MAX_HTML_CHARS) throw new HtmlRenderError(`The HTML is too large (${html.length.toLocaleString()} characters; limit 2,000,000).`);
  const paper = PAPER_CSS[paperSize];
  if (!paper) throw new HtmlRenderError(`HTML can't be laid out for paper size ${paperSize}.`);

  const doc = assembleHtml(html, paper, { borderless: !!opts.borderless, title: opts.title });
  const blocked: string[] = [];
  let requests = 0;

  const browser = await launch();
  try {
    const page = await browser.newPage();
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    page.on("request", (req: HTTPRequest) => {
      void (async () => {
        const url = req.url();
        if (req.isNavigationRequest() && req.frame() === page.mainFrame() && url === "about:blank") return req.continue();
        if (url.startsWith("data:")) return req.continue();
        let allowed = false;
        try {
          const u = new URL(url);
          allowed = u.protocol === "https:" && ++requests <= MAX_SUBRESOURCES && !req.isNavigationRequest() && (await isPublicHost(u.hostname));
        } catch {
          allowed = false;
        }
        if (allowed) return req.continue();
        blocked.push(url.length > 120 ? `${url.slice(0, 117)}…` : url);
        return req.abort("blockedbyclient");
      })().catch(() => req.abort().catch(() => {}));
    });

    await page.setContent(doc, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
    await page.emulateMediaType("print");
    const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true, timeout: RENDER_TIMEOUT_MS });
    return { bytes: new Uint8Array(pdf), blocked };
  } catch (err) {
    if (err instanceof HtmlRenderError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw new HtmlRenderError(/timeout/i.test(msg) ? "Rendering the HTML took too long (20 s). Remove slow or large external images." : `Couldn't render the HTML: ${msg}`);
  } finally {
    await browser.close().catch(() => {});
  }
}
