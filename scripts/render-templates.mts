// Renders the HTML print templates in plugins/ through the same pipeline print_document uses,
// so you can check layout and page count without printing.
//
// Usage: npm run render-templates [-- <file.html ...>] [-- --paper ps_letter]
// Output: .render/<template>-<paper>.pdf, plus PNG previews (all pages with pdftoppm, else page 1 via sips on macOS)
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { htmlToPdf } from "../lib/mcp/html-pdf";

const args = process.argv.slice(2);
const paperFlag = args.indexOf("--paper");
const forcedPaper = paperFlag >= 0 ? args.splice(paperFlag, 2)[1] : null;

function findTemplates(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return findTemplates(p);
    return p.includes("/templates/") && p.endsWith(".html") ? [p] : [];
  });
}

const files = args.length ? args : findTemplates("plugins");
const out = ".render";
mkdirSync(out, { recursive: true });

let failures = 0;
for (const file of files) {
  const html = readFileSync(file, "utf8");
  // Templates declare the papers they're designed for: <meta name="epson-paper" content="ps_a4 ps_letter">
  const declared = html.match(/<meta name="epson-paper" content="([^"]+)"/)?.[1].split(/\s+/) ?? ["ps_a4"];
  const expectedPages = Number(html.match(/<meta name="epson-pages" content="(\d+)"/)?.[1] ?? 1);
  const borderless = /<meta name="epson-borderless" content="true"/.test(html);
  for (const paper of forcedPaper ? [forcedPaper] : declared) {
    const name = `${basename(file, ".html")}-${paper.replace("ps_", "")}`;
    try {
      const { bytes, blocked } = await htmlToPdf(html, paper, { borderless });
      writeFileSync(join(out, `${name}.pdf`), bytes);
      const pages = (await PDFDocument.load(bytes)).getPageCount();
      const okPages = pages === expectedPages;
      if (!okPages || blocked.length) failures++;
      console.log(`${okPages && !blocked.length ? "OK  " : "FAIL"}  ${name}: ${pages} page(s) (expected ${expectedPages})${blocked.length ? `, blocked ${blocked.join(", ")}` : ""}`);
      // PNG previews: every page with poppler's pdftoppm if installed, else page 1 with macOS sips.
      try {
        execFileSync("pdftoppm", ["-png", "-r", "110", join(out, `${name}.pdf`), join(out, name)], { stdio: "ignore" });
      } catch {
        if (process.platform === "darwin") {
          execFileSync("sips", ["-s", "format", "png", "-Z", "1400", join(out, `${name}.pdf`), "--out", join(out, `${name}.png`)], { stdio: "ignore" });
        }
      }
    } catch (err) {
      failures++;
      console.log(`FAIL  ${name}: ${err instanceof Error ? err.message : err}`);
    }
  }
}
process.exit(failures ? 1 : 0);
