import { BREAK_PERIOD } from "@/lib/shared";

/** Tiny monthly price line; gaps break the line. A tick marks the July 2025 break. */
export function Sparkline({
  values,
  months,
  width = 96,
  height = 24,
}: {
  values: (number | null)[];
  months: string[];
  width?: number;
  height?: number;
}) {
  const nums = values.filter((v): v is number => v != null);
  if (nums.length < 2) return <span className="muted">–</span>;
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  const span = hi - lo || 1;
  const x = (i: number) => (i / (values.length - 1)) * (width - 2) + 1;
  const y = (v: number) => height - 2 - ((v - lo) / span) * (height - 4);

  const segments: string[] = [];
  let cur: string[] = [];
  values.forEach((v, i) => {
    if (v == null) {
      if (cur.length > 1) segments.push(cur.join(" "));
      cur = [];
    } else cur.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  });
  if (cur.length > 1) segments.push(cur.join(" "));
  const bi = months.indexOf(BREAK_PERIOD);

  return (
    <svg width={width} height={height} className="spark" aria-hidden="true">
      {bi >= 0 && <line x1={x(bi)} x2={x(bi)} y1={0} y2={height} className="spark-break" />}
      {segments.map((pts, i) => (
        <polyline key={i} points={pts} className="spark-line" />
      ))}
    </svg>
  );
}
