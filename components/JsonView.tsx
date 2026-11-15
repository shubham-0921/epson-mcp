"use client";

import { Fragment } from "react";

const TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

function highlight(text: string) {
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) {
      out.push(<span key={i++} className={m[2] ? "j-key" : "j-str"}>{m[1]}</span>);
      if (m[2]) out.push(m[2]);
    } else if (m[3]) out.push(<span key={i++} className="j-lit">{m[3]}</span>);
    else if (m[4]) out.push(<span key={i++} className="j-num">{m[4]}</span>);
    last = TOKEN.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export default function JsonView({ value, empty = "(empty)" }: { value: unknown; empty?: string }) {
  const isEmpty = value === undefined || value === null || value === "";
  const text = isEmpty ? empty : typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <pre className="max-h-80 overflow-auto rounded-md bg-code px-3 py-2.5 font-mono text-[12px] leading-relaxed text-code-fg whitespace-pre-wrap break-all">
      {isEmpty || typeof value === "string" ? <span className="opacity-70">{text}</span> : <Fragment>{highlight(text)}</Fragment>}
    </pre>
  );
}
