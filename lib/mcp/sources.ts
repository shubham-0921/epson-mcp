// Turns a print_document `source` into bytes the Epson client can upload.
// Phase 1 sources: markdown (rendered to PDF) and base64. url comes in Phase 3.

import { marked, type Token, type Tokens } from "marked";
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from "pdf-lib";
import { formatBytes } from "../epson/redact";

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_BASE64_BYTES = 1024 * 1024; // bytes cost context tokens; bigger files need url/upload
export const ALLOWED_MIME = ["application/pdf", "image/jpeg", "image/png"] as const;
export type AllowedMime = (typeof ALLOWED_MIME)[number];

export type PrintSource =
  | { type: "markdown"; markdown: string; title?: string }
  | { type: "html"; html: string; title?: string }
  | { type: "base64"; data: string; mimeType: string; fileName?: string };

export type PreparedFile = { bytes: Uint8Array; mime: AllowedMime; fileName: string; pages: number; notes?: string[] };

export class SourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceError";
  }
}

export async function prepareSource(source: PrintSource, paperSize = "ps_a4", opts: { borderless?: boolean } = {}): Promise<PreparedFile> {
  if (source.type === "html") {
    if (!source.html.trim()) throw new SourceError("The HTML to print is empty.");
    const { htmlToPdf } = await import("./html-pdf");
    const { bytes, blocked } = await htmlToPdf(source.html, paperSize, { borderless: opts.borderless, title: source.title });
    const notes = blocked.length ? [`Blocked ${blocked.length} resource(s) (only https on public hosts and data: URLs load): ${blocked.slice(0, 3).join(", ")}`] : undefined;
    return check({ bytes, mime: "application/pdf", fileName: `${source.title || "Document"}.pdf`, pages: await countPdfPages(bytes), notes });
  }
  if (source.type === "markdown") {
    if (!source.markdown.trim()) throw new SourceError("The markdown to print is empty.");
    const bytes = await markdownToPdf(source.markdown, paperSize);
    return check({ bytes, mime: "application/pdf", fileName: `${source.title || "Document"}.pdf`, pages: await countPdfPages(bytes) });
  }

  const raw = source.data.replace(/^data:[^;]+;base64,/, "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(raw)) throw new SourceError("base64 data is not valid base64.");
  const bytes = new Uint8Array(Buffer.from(raw, "base64"));
  if (bytes.byteLength > MAX_BASE64_BYTES)
    throw new SourceError(`base64 files are limited to ${formatBytes(MAX_BASE64_BYTES)} (this one is ${formatBytes(bytes.byteLength)}).`);
  const sniffed = sniffMime(bytes);
  if (!sniffed) throw new SourceError("Only PDF, JPEG and PNG files can be printed. The data doesn't look like any of them.");
  if (source.mimeType && source.mimeType !== sniffed && !(source.mimeType === "image/jpg" && sniffed === "image/jpeg"))
    throw new SourceError(`mimeType says ${source.mimeType} but the data is ${sniffed}.`);
  const pages = sniffed === "application/pdf" ? await countPdfPages(bytes) : 1;
  return check({ bytes, mime: sniffed, fileName: source.fileName || `file.${sniffed.split("/")[1]}`, pages });
}

function check(f: PreparedFile): PreparedFile {
  if (f.bytes.byteLength === 0) throw new SourceError("The file is empty.");
  if (f.bytes.byteLength > MAX_FILE_BYTES) throw new SourceError(`The file is ${formatBytes(f.bytes.byteLength)}; the limit is 20 MB.`);
  return f;
}

export function sniffMime(b: Uint8Array): AllowedMime | null {
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "application/pdf"; // %PDF
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  return null;
}

export async function countPdfPages(bytes: Uint8Array): Promise<number> {
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    return doc.getPageCount();
  } catch {
    throw new SourceError("The PDF could not be read. It may be damaged.");
  }
}

// ---------------------------------------------------------------------------
// Markdown → PDF (pure JS). Supports headings, paragraphs with bold/italic/code,
// bullet, numbered and task lists, block quotes, code blocks, rules and tables.
// Uses the PDF standard fonts, so characters outside Windows-1252 print as "?".
// ---------------------------------------------------------------------------

const PAGE_SIZES: Record<string, [number, number]> = {
  ps_a4: [595.28, 841.89],
  ps_letter: [612, 792],
  ps_legal: [612, 1008],
  ps_a5: [419.53, 595.28],
};
const MARGIN = 56;
const INK = rgb(0.1, 0.1, 0.12);
const MUTED = rgb(0.42, 0.45, 0.5);
const RULE = rgb(0.8, 0.82, 0.86);

type Run = { text: string; bold?: boolean; italic?: boolean; code?: boolean; br?: boolean };
type Fonts = { regular: PDFFont; bold: PDFFont; italic: PDFFont; boldItalic: PDFFont; mono: PDFFont };

const REPLACE: Record<string, string> = { "→": "->", "←": "<-", "✓": "v", "✔": "v", "✗": "x", "☐": "[ ]", "☑": "[x]", "≥": ">=", "≤": "<=", "≠": "!=", " ": " " };

class Writer {
  page!: PDFPage;
  y = 0;
  private safe = new Map<string, boolean>();

  constructor(
    private doc: PDFDocument,
    private f: Fonts,
    private size: [number, number],
  ) {
    this.newPage();
  }

  get width() {
    return this.size[0] - MARGIN * 2;
  }

  newPage() {
    this.page = this.doc.addPage(this.size);
    this.y = this.size[1] - MARGIN;
  }

  ensure(h: number) {
    if (this.y - h < MARGIN) this.newPage();
  }

  gap(h: number) {
    this.y -= h;
  }

  font(r: Run): PDFFont {
    if (r.code) return this.f.mono;
    if (r.bold && r.italic) return this.f.boldItalic;
    if (r.bold) return this.f.bold;
    if (r.italic) return this.f.italic;
    return this.f.regular;
  }

  /** Replace characters the standard fonts can't encode. */
  clean(text: string, font: PDFFont): string {
    let out = "";
    for (const ch of text) {
      const c = REPLACE[ch] ?? ch;
      const key = `${font.name}:${c}`;
      if (!this.safe.has(key)) {
        try {
          font.encodeText(c);
          this.safe.set(key, true);
        } catch {
          this.safe.set(key, false);
        }
      }
      out += this.safe.get(key) ? c : "?";
    }
    return out;
  }

  /** Lay out runs with word wrap; returns the lines without drawing them. */
  layout(runs: Run[], size: number, width: number) {
    type Piece = { text: string; font: PDFFont; w: number };
    const lines: Piece[][] = [[]];
    let x = 0;
    const push = (p: Piece) => {
      lines.at(-1)!.push(p);
      x += p.w;
    };
    const breakLine = () => {
      const last = lines.at(-1)!;
      while (last.length && !last.at(-1)!.text.trim()) last.pop(); // trailing spaces
      lines.push([]);
      x = 0;
    };
    for (const r of runs) {
      if (r.br) {
        breakLine();
        continue;
      }
      const font = this.font(r);
      for (const part of this.clean(r.text, font).split(/(\s+)/)) {
        if (!part) continue;
        if (/^\s+$/.test(part)) {
          if (x > 0) push({ text: " ", font, w: font.widthOfTextAtSize(" ", size) });
          continue;
        }
        let word = part;
        let w = font.widthOfTextAtSize(word, size);
        if (x > 0 && x + w > width) breakLine();
        while (w > width) {
          // A single word wider than the line: hard-break it.
          let n = word.length;
          while (n > 1 && font.widthOfTextAtSize(word.slice(0, n), size) > width) n--;
          push({ text: word.slice(0, n), font, w: font.widthOfTextAtSize(word.slice(0, n), size) });
          breakLine();
          word = word.slice(n);
          w = font.widthOfTextAtSize(word, size);
        }
        push({ text: word, font, w });
      }
    }
    return lines.filter((l, i) => l.length || i < lines.length - 1);
  }

  /** Draws wrapped runs at the current position and advances y. */
  text(runs: Run[], o: { size: number; x?: number; width?: number; lead?: number; color?: ReturnType<typeof rgb>; first?: string }) {
    const x0 = MARGIN + (o.x ?? 0);
    const width = o.width ?? this.width - (o.x ?? 0);
    const lh = o.size * (o.lead ?? 1.4);
    const lines = this.layout(runs, o.size, width);
    if (!lines.length && o.first) lines.push([]); // a list marker with nothing beside it
    lines.forEach((line, i) => {
      this.ensure(lh);
      this.y -= lh;
      if (i === 0 && o.first) {
        this.page.drawText(this.clean(o.first, this.f.regular), { x: x0 - (o.first.startsWith("[") ? 22 : 14), y: this.y + o.size * 0.25, size: o.size, font: this.f.regular, color: o.color ?? INK });
      }
      let x = x0;
      for (const p of line) {
        if (p.text.trim()) this.page.drawText(p.text, { x, y: this.y + o.size * 0.25, size: o.size, font: p.font, color: o.color ?? INK });
        x += p.w;
      }
    });
  }

  rule() {
    this.ensure(14);
    this.y -= 7;
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: MARGIN + this.width, y: this.y }, thickness: 0.75, color: RULE });
    this.y -= 7;
  }
}

function inlineRuns(tokens: Token[] | undefined, style: Omit<Run, "text"> = {}): Run[] {
  const out: Run[] = [];
  for (const t of tokens ?? []) {
    switch (t.type) {
      case "strong":
        out.push(...inlineRuns((t as Tokens.Strong).tokens, { ...style, bold: true }));
        break;
      case "em":
        out.push(...inlineRuns((t as Tokens.Em).tokens, { ...style, italic: true }));
        break;
      case "codespan":
        out.push({ ...style, code: true, text: decode((t as Tokens.Codespan).text) });
        break;
      case "br":
        out.push({ text: "", br: true });
        break;
      case "link": {
        const l = t as Tokens.Link;
        out.push(...inlineRuns(l.tokens, style));
        if (l.href && l.text !== l.href && !l.href.startsWith("#")) out.push({ ...style, text: ` (${l.href})` });
        break;
      }
      case "del":
        out.push(...inlineRuns((t as Tokens.Del).tokens, style));
        break;
      case "text": {
        const tt = t as Tokens.Text;
        if (tt.tokens?.length) out.push(...inlineRuns(tt.tokens, style));
        else out.push({ ...style, text: decode(tt.text) });
        break;
      }
      default:
        if ("text" in t && typeof t.text === "string") out.push({ ...style, text: decode(t.text) });
    }
  }
  return out;
}

const decode = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

function blocks(w: Writer, tokens: Token[], indent = 0) {
  for (const t of tokens) {
    switch (t.type) {
      case "heading": {
        const h = t as Tokens.Heading;
        const size = [0, 20, 16, 13.5, 12, 11, 11][h.depth];
        w.gap(h.depth <= 2 ? 10 : 6);
        w.ensure(size * 3);
        w.text(inlineRuns(h.tokens, { bold: true }), { size, x: indent, lead: 1.25 });
        if (h.depth === 1) w.rule();
        else w.gap(4);
        break;
      }
      case "paragraph":
        w.text(inlineRuns((t as Tokens.Paragraph).tokens), { size: 11, x: indent });
        w.gap(6);
        break;
      case "text": {
        const tt = t as Tokens.Text;
        w.text(tt.tokens ? inlineRuns(tt.tokens) : [{ text: decode(tt.text) }], { size: 11, x: indent });
        break;
      }
      case "list": {
        const l = t as Tokens.List;
        let n = typeof l.start === "number" ? l.start : 1;
        for (const item of l.items) {
          const marker = item.task ? (item.checked ? "[x]" : "[ ]") : l.ordered ? `${n++}.` : "•";
          const [first, ...rest] = item.tokens.filter((tk) => tk.type !== "checkbox");
          const x = indent + (item.task ? 26 : 16);
          if (first && (first.type === "text" || first.type === "paragraph")) {
            const ft = first as Tokens.Text;
            w.text(ft.tokens ? inlineRuns(ft.tokens) : [{ text: decode(ft.text) }], { size: 11, x, first: marker });
            blocks(w, rest, x);
          } else {
            w.text([], { size: 11, x, first: marker });
            blocks(w, [first, ...rest].filter(Boolean), x);
          }
        }
        w.gap(6);
        break;
      }
      case "blockquote": {
        const startY = w.y;
        const startPage = w.page;
        blocks(w, (t as Tokens.Blockquote).tokens, indent + 14);
        if (w.page === startPage) {
          w.page.drawLine({ start: { x: MARGIN + indent + 2, y: startY - 4 }, end: { x: MARGIN + indent + 2, y: w.y + 4 }, thickness: 2, color: RULE });
        }
        break;
      }
      case "code": {
        const lines = decode((t as Tokens.Code).text).split("\n");
        w.gap(2);
        for (const line of lines) w.text([{ text: line || " ", code: true }], { size: 9.5, x: indent + 8, lead: 1.35, color: MUTED });
        w.gap(8);
        break;
      }
      case "hr":
        w.rule();
        break;
      case "table":
        table(w, t as Tokens.Table, indent);
        break;
      case "space":
        break;
      default:
        if ("text" in t && typeof t.text === "string" && t.text.trim()) {
          w.text([{ text: decode(t.text) }], { size: 11, x: indent });
          w.gap(6);
        }
    }
  }
}

function table(w: Writer, t: Tokens.Table, indent: number) {
  const cols = t.header.length;
  const width = w.width - indent;
  const colW = width / cols;
  const pad = 5;
  const size = 9.5;
  const lh = size * 1.35;
  const rows: { cells: Run[][]; header: boolean }[] = [
    { cells: t.header.map((c) => inlineRuns(c.tokens, { bold: true })), header: true },
    ...t.rows.map((r) => ({ cells: r.map((c) => inlineRuns(c.tokens)), header: false })),
  ];
  w.gap(4);
  for (const row of rows) {
    const laid = row.cells.map((runs) => w.layout(runs, size, colW - pad * 2));
    const h = Math.max(1, ...laid.map((l) => l.length)) * lh + pad * 2;
    w.ensure(h);
    const top = w.y;
    laid.forEach((lines, ci) => {
      const x0 = MARGIN + indent + ci * colW;
      if (row.header) w.page.drawRectangle({ x: x0, y: top - h, width: colW, height: h, color: rgb(0.95, 0.96, 0.97) });
      w.page.drawRectangle({ x: x0, y: top - h, width: colW, height: h, borderColor: RULE, borderWidth: 0.6 });
      lines.forEach((line, li) => {
        let x = x0 + pad;
        const y = top - pad - (li + 1) * lh + size * 0.3;
        for (const p of line) {
          if (p.text.trim()) w.page.drawText(p.text, { x, y, size, font: p.font, color: INK });
          x += p.w;
        }
      });
    });
    w.y = top - h;
  }
  w.gap(10);
}

export async function markdownToPdf(markdown: string, paperSize = "ps_a4"): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setProducer("Epson Print MCP");
  doc.setCreator("Epson Print MCP");
  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
    boldItalic: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
    mono: await doc.embedFont(StandardFonts.Courier),
  };
  const w = new Writer(doc, fonts, PAGE_SIZES[paperSize] ?? PAGE_SIZES.ps_a4);
  blocks(w, marked.lexer(markdown, { gfm: true }));
  return doc.save();
}
