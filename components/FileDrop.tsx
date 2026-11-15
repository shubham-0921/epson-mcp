"use client";

import { useRef, useState } from "react";
import { formatBytes } from "@/lib/epson/redact";

export const ACCEPT = ["application/pdf", "image/jpeg", "image/png"];
export const MAX_BYTES = 20 * 1024 * 1024;

export function validateClientFile(f: File): string | null {
  if (!ACCEPT.includes(f.type)) return `Unsupported file type (${f.type || "unknown"}). Use PDF, JPEG or PNG.`;
  if (f.size > MAX_BYTES) return `File is ${formatBytes(f.size)} — the limit is 20 MB.`;
  if (f.size === 0) return "File is empty.";
  return null;
}

export default function FileDrop({ file, onFile, disabled }: { file: File | null; onFile: (f: File | null, error?: string) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const take = (f?: File) => {
    if (!f) return;
    const err = validateClientFile(f);
    onFile(err ? null : f, err ?? undefined);
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (!disabled) take(e.dataTransfer.files[0]);
      }}
      onClick={() => !disabled && input.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && input.current?.click()}
      className={`cursor-pointer rounded-lg border-2 border-dashed px-4 py-5 text-center transition-colors ${
        over ? "border-accent bg-info-bg" : "border-line hover:border-muted"
      } ${disabled ? "pointer-events-none opacity-60" : ""}`}
    >
      <input
        ref={input}
        type="file"
        accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
        className="hidden"
        onChange={(e) => {
          take(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      {file ? (
        <div className="flex items-center justify-center gap-3">
          <span className="rounded bg-panel-2 px-2 py-1 font-mono text-[11px] font-semibold uppercase text-muted">
            {file.name.split(".").pop()}
          </span>
          <span className="min-w-0 text-left">
            <span className="block max-w-64 truncate text-[13px] font-medium">{file.name}</span>
            <span className="block text-[12px] text-muted">{formatBytes(file.size)} · {file.type}</span>
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onFile(null);
            }}
            className="ml-2 rounded-md px-2 py-1 text-[12px] text-muted hover:bg-panel-2 hover:text-fg"
          >
            Remove
          </button>
        </div>
      ) : (
        <div className="text-[13px]">
          <div className="font-medium">Drop a file here or click to choose</div>
          <div className="mt-0.5 text-[12px] text-muted">PDF, JPEG or PNG · up to 20 MB</div>
        </div>
      )}
    </div>
  );
}
