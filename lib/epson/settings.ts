// Print settings logic shared by the console UI and the MCP tools. No React.

import type { Capability, PrintSettings } from "./types";
import { colorLabel, matchOption, paperSizeLabel, paperTypeLabel, qualityLabel, sourceLabel } from "./labels";

const pick = (opts: string[], preferred: string[], current?: string) =>
  (current && opts.includes(current) ? current : preferred.find((p) => opts.includes(p))) ?? opts[0] ?? "";

/** Resolve a valid settings combination from the capability response, keeping current choices where still valid. */
export function resolveSettings(cap: Capability, cur: Partial<PrintSettings> = {}): PrintSettings {
  const sizes = cap.paperSizes.map((p) => p.paperSize);
  const paperSize = pick(sizes, ["ps_a4", "ps_letter"], cur.paperSize);
  const types = cap.paperSizes.find((p) => p.paperSize === paperSize)?.paperTypes ?? [];
  const paperType = pick(types.map((t) => t.paperType), ["pt_plainpaper"], cur.paperType);
  const t = types.find((x) => x.paperType === paperType);
  return {
    paperSize,
    paperType,
    paperSource: pick(t?.paperSources ?? [], [], cur.paperSource),
    printQuality: pick(t?.printQualities ?? [], ["normal"], cur.printQuality),
    borderless: !!t?.borderless && !!cur.borderless,
    colorMode: pick(cap.colorModes, ["color"], cur.colorMode),
    copies: cur.copies ?? 1,
  };
}

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsError";
  }
}

/** Readable settings as a caller (e.g. Claude) would give them. Every field optional. */
export type SettingsRequest = {
  paperSize?: string;
  paperType?: string;
  quality?: string;
  color?: string;
  source?: string;
  borderless?: boolean;
  copies?: number;
};

const list = (opts: string[], label: (s: string) => string) => opts.map(label).join(", ");

/**
 * Turns readable settings into a combination this printer supports, or throws a
 * SettingsError that names the valid options. Unset fields use the defaults.
 */
export function settingsFromRequest(cap: Capability, req: SettingsRequest): PrintSettings {
  const cur: Partial<PrintSettings> = { copies: req.copies ?? 1 };
  if (cur.copies! < 1 || cur.copies! > 10 || !Number.isInteger(cur.copies)) throw new SettingsError("Copies must be a whole number from 1 to 10.");

  const sizes = cap.paperSizes.map((p) => p.paperSize);
  if (req.paperSize) {
    cur.paperSize = matchOption(req.paperSize, sizes, paperSizeLabel);
    if (!cur.paperSize) throw new SettingsError(`Paper size "${req.paperSize}" isn't supported. Options: ${list(sizes, paperSizeLabel)}.`);
  }
  let s = resolveSettings(cap, cur);

  const types = cap.paperSizes.find((p) => p.paperSize === s.paperSize)!.paperTypes;
  if (req.paperType) {
    const t = matchOption(req.paperType, types.map((x) => x.paperType), paperTypeLabel);
    if (!t)
      throw new SettingsError(
        `Paper type "${req.paperType}" isn't available for ${paperSizeLabel(s.paperSize)}. Options: ${list(types.map((x) => x.paperType), paperTypeLabel)}.`,
      );
    s = resolveSettings(cap, { ...s, paperType: t });
  }

  const t = types.find((x) => x.paperType === s.paperType)!;
  const where = `${paperSizeLabel(s.paperSize)} ${paperTypeLabel(s.paperType).toLowerCase()}`;
  if (req.quality) {
    const q = matchOption(req.quality, t.printQualities, qualityLabel);
    if (!q) throw new SettingsError(`Quality "${req.quality}" isn't available on ${where}. Options: ${list(t.printQualities, qualityLabel)}.`);
    s.printQuality = q;
  }
  if (req.source) {
    const src = matchOption(req.source, t.paperSources, sourceLabel);
    if (!src) throw new SettingsError(`Paper source "${req.source}" isn't available on ${where}. Options: ${list(t.paperSources, sourceLabel)}.`);
    s.paperSource = src;
  }
  if (req.color) {
    const c = matchOption(req.color, cap.colorModes, colorLabel);
    if (!c) throw new SettingsError(`Color mode "${req.color}" isn't supported. Options: ${list(cap.colorModes, colorLabel)}.`);
    s.colorMode = c;
  }
  if (req.borderless) {
    if (!t.borderless) {
      const ok = types.filter((x) => x.borderless).map((x) => x.paperType);
      throw new SettingsError(
        `Borderless isn't available on ${where}.${ok.length ? ` Paper types that allow it: ${list(ok, paperTypeLabel)}.` : ""}`,
      );
    }
    s.borderless = true;
  }
  return s;
}

/** Human-readable description of the settings actually used. */
export function describeSettings(s: PrintSettings) {
  return {
    paperSize: paperSizeLabel(s.paperSize),
    paperType: paperTypeLabel(s.paperType),
    quality: qualityLabel(s.printQuality),
    color: colorLabel(s.colorMode),
    source: sourceLabel(s.paperSource),
    borderless: s.borderless,
    copies: s.copies,
  };
}
