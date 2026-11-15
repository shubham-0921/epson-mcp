"use client";

import type { Capability, PrintMode, PrintSettings } from "@/lib/epson/types";
import { colorLabel, paperSizeLabel, paperTypeLabel, qualityLabel, sourceLabel } from "@/lib/epson/labels";
import { resolveSettings } from "@/lib/epson/settings";

export { resolveSettings };

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11.5px] font-medium text-muted">{label}</span>
      {children}
    </label>
  );
}

const selectCls =
  "w-full rounded-md border border-line px-2.5 py-1.5 text-[13px] outline-none focus:border-accent disabled:opacity-50";

function Select({ value, options, label, onChange, disabled }: { value: string; options: string[]; label: (s: string) => string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <select className={selectCls} value={value} disabled={disabled || !options.length} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => (
        <option key={o} value={o}>
          {label(o)}
        </option>
      ))}
    </select>
  );
}

export default function Settings({
  mode,
  onModeChange,
  cap,
  loading,
  error,
  value,
  onChange,
  disabled,
}: {
  mode: PrintMode;
  onModeChange: (m: PrintMode) => void;
  cap: Capability | null;
  loading: boolean;
  error: string | null;
  value: PrintSettings | null;
  onChange: (s: PrintSettings) => void;
  disabled?: boolean;
}) {
  const types = cap?.paperSizes.find((p) => p.paperSize === value?.paperSize)?.paperTypes ?? [];
  const t = types.find((x) => x.paperType === value?.paperType);
  const set = (patch: Partial<PrintSettings>) => cap && value && onChange(resolveSettings(cap, { ...value, ...patch }));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-[13px] font-semibold">Print settings</h3>
        <div className="flex rounded-md border border-line p-0.5 text-[12px]">
          {(["document", "photo"] as const).map((m) => (
            <button
              key={m}
              type="button"
              disabled={disabled}
              onClick={() => onModeChange(m)}
              className={`rounded px-2.5 py-0.5 font-medium capitalize ${mode === m ? "bg-accent text-accent-fg" : "text-muted hover:text-fg"}`}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <div className="rounded-md bg-err-bg px-3 py-2 text-[12.5px] text-err">Couldn’t load capabilities: {error}</div>
      ) : loading || !cap || !value ? (
        <div className="grid grid-cols-2 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-[52px] animate-pulse rounded-md bg-panel-2" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Paper size">
            <Select disabled={disabled} value={value.paperSize} options={cap.paperSizes.map((p) => p.paperSize)} label={paperSizeLabel} onChange={(v) => set({ paperSize: v })} />
          </Field>
          <Field label="Paper type">
            <Select disabled={disabled} value={value.paperType} options={types.map((x) => x.paperType)} label={paperTypeLabel} onChange={(v) => set({ paperType: v })} />
          </Field>
          <Field label="Quality">
            <Select disabled={disabled} value={value.printQuality} options={t?.printQualities ?? []} label={qualityLabel} onChange={(v) => set({ printQuality: v })} />
          </Field>
          <Field label="Color">
            <Select disabled={disabled} value={value.colorMode} options={cap.colorModes} label={colorLabel} onChange={(v) => set({ colorMode: v })} />
          </Field>
          <Field label="Paper source">
            <Select disabled={disabled} value={value.paperSource} options={t?.paperSources ?? []} label={sourceLabel} onChange={(v) => set({ paperSource: v })} />
          </Field>
          <Field label="Copies">
            <input
              type="number"
              min={1}
              max={10}
              disabled={disabled}
              value={value.copies}
              onChange={(e) => set({ copies: Math.max(1, Math.min(10, Math.round(Number(e.target.value) || 1))) })}
              className={selectCls}
            />
          </Field>
          <label className={`col-span-2 flex items-center gap-2 text-[12.5px] ${t?.borderless ? "" : "opacity-50"}`}>
            <input type="checkbox" disabled={disabled || !t?.borderless} checked={value.borderless} onChange={(e) => set({ borderless: e.target.checked })} />
            Borderless {t?.borderless ? "" : "(not supported for this paper)"}
          </label>
        </div>
      )}
    </div>
  );
}
