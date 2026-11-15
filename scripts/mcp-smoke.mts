/* eslint-disable @typescript-eslint/no-explicit-any -- test script reads loosely-typed tool results */
// Starts the stdio MCP server in mock mode and calls every tool through a real MCP client.
// Usage: npm run mcp:smoke
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PDFDocument } from "pdf-lib";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", "mcp/stdio.mts"],
  env: { ...process.env, EPSON_MOCK: "true" } as Record<string, string>,
  stderr: "pipe",
});
const client = new Client({ name: "smoke", version: "0.0.1" });
await client.connect(transport);

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[]; structuredContent?: any };
  return { ...r, text: r.content.map((c) => c.text).join(" ") };
};

const tools = (await client.listTools()).tools;
check("lists 4 tools", tools.length === 4, tools.map((t) => t.name).join(", "));
check("print_document is not read-only", tools.find((t) => t.name === "print_document")?.annotations?.readOnlyHint === false);

const status = await call("get_printer_status");
check("get_printer_status", !status.isError && status.structuredContent?.online === true, status.text);

const opts = await call("get_print_options", { mode: "document" });
check("get_print_options", !opts.isError && opts.structuredContent?.defaults?.paperSize === "A4", opts.text.slice(0, 120) + "…");

const p1 = await call("print_document", { source: { type: "markdown", title: "Shopping list", markdown: "# Shopping\n\n- milk\n- eggs" } });
check("print markdown with defaults", !p1.isError && !!p1.structuredContent?.jobId, p1.text);

const p2 = await call("print_document", {
  source: { type: "markdown", markdown: "Hello" }, paper_size: "letter", paper_type: "plain", quality: "draft", color: "black and white", copies: 2,
});
const s2 = p2.structuredContent?.settings;
check("readable settings map to codes", !p2.isError && s2?.paperSize === "Letter" && s2?.color === "Black & white" && s2?.quality === "Draft" && s2?.copies === 2, JSON.stringify(s2));

const e1 = await call("print_document", { source: { type: "markdown", markdown: "x" }, borderless: true });
check("borderless on plain paper is refused", !!e1.isError && /Borderless isn't available/.test(e1.text), e1.text);

const e2 = await call("print_document", { source: { type: "markdown", markdown: "x" }, paper_size: "A3" });
check("unsupported size lists options", !!e2.isError && /Options: A4, Letter/.test(e2.text), e2.text);

const h1 = await call("print_document", {
  source: { type: "html", title: "Table tent", html: "<style>.t{height:50%;display:flex;align-items:center;justify-content:center;font:700 40pt sans-serif}.r{transform:rotate(180deg)}</style><div class='t r'>Reserved</div><div class='t'>Reserved</div>" },
  paper_size: "A5",
});
check("print html on A5", !h1.isError && h1.structuredContent?.pages === 1 && h1.structuredContent?.settings?.paperSize === "A5", h1.text);
const h2 = await call("print_document", {
  source: { type: "html", html: "<p>Hi</p><img src='http://169.254.169.254/x.png'>" },
});
check("html blocks internal URLs and says so", !h2.isError && /Blocked 1 resource/.test(h2.text), h2.text.replace(/.*Note: /, "Note: "));
const h3 = await call("print_document", {
  source: { type: "html", html: Array.from({ length: 40 }, (_, i) => `<section style="page-break-after:always">Page ${i + 1}</section>`).join("") },
});
check("html page count feeds the 30-page limit", !!h3.isError && /40 pages/.test(h3.text), h3.text);

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const p3 = await call("print_document", { source: { type: "base64", data: png, mimeType: "image/png", fileName: "dot.png" }, paper_size: "4x6" });
check("base64 PNG prints as photo", !p3.isError && p3.structuredContent?.settings?.paperSize === "4 × 6 in", p3.text);

const e3 = await call("print_document", { source: { type: "base64", data: png, mimeType: "application/pdf" } });
check("mime mismatch is refused", !!e3.isError && /says application\/pdf but the data is image\/png/.test(e3.text), e3.text);

const doc = await PDFDocument.create();
for (let i = 0; i < 12; i++) doc.addPage();
const big = Buffer.from(await doc.save()).toString("base64");
const e4 = await call("print_document", { source: { type: "base64", data: big, mimeType: "application/pdf" }, copies: 3 });
check("36 pages needs confirm_large", !!e4.isError && /36 pages/.test(e4.text), e4.text);
const p4 = await call("print_document", { source: { type: "base64", data: big, mimeType: "application/pdf" }, copies: 3, confirm_large: true });
check("confirm_large lets it through", !p4.isError && p4.structuredContent?.pages === 12, p4.text);

const fresh = await call("print_document", { source: { type: "markdown", markdown: "Wait test" } });
const progress: string[] = [];
const w = (await client.callTool(
  { name: "get_print_job_status", arguments: { job_id: fresh.structuredContent.jobId, wait_seconds: 20 } },
  undefined,
  { onprogress: (pr) => progress.push(pr.message ?? ""), timeout: 60_000 },
)) as any;
check("waits until printed", w.structuredContent?.status === "completed" && w.structuredContent?.final === true, w.content[0].text);
check("sends progress notifications", progress.length >= 2, progress.join(" → "));

await client.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
