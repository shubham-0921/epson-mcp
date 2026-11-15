const PAPER_SIZES: Record<string, string> = {
  ps_a3: "A3", ps_a4: "A4", ps_a5: "A5", ps_a6: "A6", ps_b4: "B4", ps_b5: "B5",
  ps_letter: "Letter", ps_legal: "Legal", ps_executive: "Executive",
  ps_4x6: "4 × 6 in", ps_5x7: "5 × 7 in", ps_8x10: "8 × 10 in", ps_l: "L (89 × 127 mm)", ps_2l: "2L (127 × 178 mm)",
  ps_hagaki: "Hagaki", ps_kg: "KG", ps_16x9: "16:9 wide", ps_envelope10: "Envelope #10", ps_envelopedl: "Envelope DL",
};
const PAPER_TYPES: Record<string, string> = {
  pt_plainpaper: "Plain paper", pt_photopaper: "Photo paper", pt_mattepaper: "Matte paper",
  pt_glossypaper: "Glossy paper", pt_envelope: "Envelope", pt_postcard: "Postcard", pt_premiumglossy: "Premium glossy",
};
const QUALITIES: Record<string, string> = { draft: "Draft", normal: "Normal", high: "High", best: "Best" };
const COLORS: Record<string, string> = { color: "Color", mono: "Black & white", grayscale: "Grayscale" };
const SOURCES: Record<string, string> = { rear: "Rear tray", front: "Front tray", front1: "Front tray 1", front2: "Front tray 2", cassette: "Cassette", auto: "Auto", manual: "Manual feed" };

function humanize(raw: string) {
  const s = raw.replace(/^(ps|pt)_/, "").replace(/_/g, " ");
  return `${s.charAt(0).toUpperCase()}${s.slice(1)} (${raw})`;
}

const lookup = (map: Record<string, string>) => (raw: string) => map[raw] ?? humanize(raw);

export const paperSizeLabel = lookup(PAPER_SIZES);
export const paperTypeLabel = lookup(PAPER_TYPES);
export const qualityLabel = lookup(QUALITIES);
export const colorLabel = lookup(COLORS);
export const sourceLabel = lookup(SOURCES);

// ---------- Readable input → Epson code (used by the MCP tools) ----------

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

const SYNONYMS: Record<string, string> = {
  bw: "mono", blackandwhite: "mono", blackwhite: "mono", monochrome: "mono", grayscale: "mono", greyscale: "mono", gray: "mono", grey: "mono",
  colour: "color", fullcolor: "color", fullcolour: "color",
  plain: "pt_plainpaper", normalpaper: "pt_plainpaper", photo: "pt_photopaper", glossy: "pt_photopaper", matte: "pt_mattepaper",
  usletter: "ps_letter", uslegal: "ps_legal", "4x6": "ps_4x6", "46": "ps_4x6", "5x7": "ps_5x7", "57": "ps_5x7",
};

/**
 * Finds the Epson code among `options` that a readable value refers to:
 * "A4", "a4", "ps_a4", "Plain paper", "plain", "black and white" …
 * Returns undefined if nothing matches.
 */
export function matchOption(input: string, options: string[], label: (raw: string) => string): string | undefined {
  const n = norm(input);
  if (!n) return undefined;
  const syn = SYNONYMS[n];
  for (const o of options) {
    const bare = o.replace(/^(ps|pt)_/, "");
    if ([norm(o), norm(bare), norm(label(o))].includes(n) || (syn && norm(o) === norm(syn))) return o;
  }
  // Prefix match on the label, e.g. "plain" → "Plain paper", "photo" → "Photo paper".
  const prefixed = options.filter((o) => norm(label(o)).startsWith(n));
  return prefixed.length === 1 ? prefixed[0] : undefined;
}
