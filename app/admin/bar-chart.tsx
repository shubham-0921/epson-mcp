// Single-series daily bar chart (server-rendered SVG). Hovering a day shows its value.

type Point = { label: string; value: number };

const W = 480;
const H = 180;
const PAD = { top: 10, right: 8, bottom: 24, left: 32 };

function niceMax(v: number) {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v)!;
}

export function BarChart({ data, unit }: { data: Point[]; unit: string }) {
  const max = niceMax(Math.max(0, ...data.map((d) => d.value)));
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const slot = plotW / data.length;
  const gap = Math.min(2, slot * 0.2);
  const bw = Math.max(1, slot - gap);
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;
  const ticks = [0, max / 2, max];
  const every = Math.ceil(data.length / 6);
  const total = data.reduce((n, d) => n + d.value, 0);

  return (
    <figure className="m-0">
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label={`${total} ${unit} over ${data.length} days`}>
        <style>{`.bc-hit:hover + .bc-bar, .bc-hit:focus + .bc-bar { fill: var(--fg); }`}</style>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth={1} />
            <text x={PAD.left - 6} y={y(t) + 4} textAnchor="end" fontSize={12} fill="var(--muted)">
              {Number.isInteger(t) ? t : t.toFixed(1)}
            </text>
          </g>
        ))}
        {data.map((d, i) => {
          const x = PAD.left + i * slot + gap / 2;
          const h = Math.max(0, y(0) - y(d.value));
          const r = Math.min(4, bw / 2, h);
          // Rounded top, square base anchored to the baseline.
          const path = h
            ? `M${x},${y(0)} V${y(d.value) + r} Q${x},${y(d.value)} ${x + r},${y(d.value)} H${x + bw - r} Q${x + bw},${y(d.value)} ${x + bw},${y(d.value) + r} V${y(0)} Z`
            : "";
          return (
            <g key={i}>
              <rect className="bc-hit" x={PAD.left + i * slot} y={PAD.top} width={slot} height={plotH} fill="transparent">
                <title>{`${d.label}: ${d.value} ${unit}`}</title>
              </rect>
              {path && <path className="bc-bar" d={path} fill="var(--accent)" pointerEvents="none" />}
              {(i % every === 0 || i === data.length - 1) && (data.length - 1 - i >= every || i === data.length - 1) && (
                <text x={x + bw / 2} y={H - 6} textAnchor="middle" fontSize={12} fill="var(--muted)">
                  {d.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-1 text-[11px] text-muted">
        {total.toLocaleString("en-US")} {unit} in {data.length} days · hover a bar for the day&apos;s value
      </figcaption>
    </figure>
  );
}
