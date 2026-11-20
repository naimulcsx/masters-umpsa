// Forecasting-candidate rules, shared by the Candidates page and the item header.
import { fmtMonth, STATES } from "./shared";

export interface ItemMetrics {
  item_code: number;
  first_period: string | null;
  last_period: string | null;
  coverage: number;
  state_density: Record<string, number>;
  change_rate: number | null;
  weekly_vol: number | null;
  cv: number | null;
  seasonal_strength: number | null;
  spectral_entropy: number | null;
  break_shift: number | null;
  break_premises: number | null;
  avg_premises: number;
  spark?: (number | null)[];
}

export interface MetricsFile {
  minPremises: number;
  start: string;
  weeks: number;
  lastWeek: string;
  months: string[];
  items: ItemMetrics[];
}

export interface Thresholds {
  aliveWeeks: number; // must have data within this many weeks of the latest week
  minCoverage: number; // share of weeks with a usable national value
  minDensity: number; // a state is "dense" if it has data in at least this share of weeks
  minDenseStates: number;
  minChangeRate: number; // share of weeks in which the national median moves
  topN: number; // headline set: the N most volatile candidates
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  aliveWeeks: 4,
  minCoverage: 0.95,
  minDensity: 0.9,
  minDenseStates: 13,
  minChangeRate: 0.2,
  topN: 20,
};

/** Level shift at the July 2025 break large enough to flag. */
export const BREAK_FLAG = 0.1;

export type Status = "headline" | "candidate" | "excluded";
export type Gate = "alive" | "coverage" | "states" | "moving";

export const GATES: { key: Gate; label: string }[] = [
  { key: "alive", label: "Still reported" },
  { key: "coverage", label: "Complete history" },
  { key: "states", label: "Enough dense states" },
  { key: "moving", label: "Price moves" },
];

export interface Evaluation {
  status: Status;
  failedGate: Gate | null; // first gate failed, in GATES order
  reasons: string[];
  denseStates: number;
  breakFlag: boolean;
}

function weeksBefore(isoDate: string, weeks: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - weeks * 7);
  return d.toISOString().slice(0, 10);
}

export function denseStateCount(m: ItemMetrics, minDensity: number): number {
  return STATES.filter((s) => (m.state_density[s] ?? 0) >= minDensity).length;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

/** Apply the gates to every item, then mark the top-N most volatile passing items as the headline set. */
export function evaluateAll(
  metrics: ItemMetrics[],
  t: Thresholds,
  lastWeek: string,
): Map<number, Evaluation> {
  const aliveSince = weeksBefore(lastWeek, t.aliveWeeks);
  const out = new Map<number, Evaluation>();
  const passing: ItemMetrics[] = [];

  for (const m of metrics) {
    const denseStates = denseStateCount(m, t.minDensity);
    const fails: [Gate, string][] = [];
    if (!m.last_period || m.last_period < aliveSince)
      fails.push(["alive", m.last_period ? `ended ${fmtMonth(m.last_period)}` : "no usable data"]);
    if (m.coverage < t.minCoverage) fails.push(["coverage", `history covers ${pct(m.coverage)} of weeks`]);
    if (denseStates < t.minDenseStates) fails.push(["states", `only ${denseStates} dense states`]);
    if ((m.change_rate ?? 0) < t.minChangeRate)
      fails.push(["moving", `price changes in ${pct(m.change_rate ?? 0)} of weeks`]);

    const breakFlag = m.break_shift != null && Math.abs(m.break_shift) >= BREAK_FLAG;
    out.set(m.item_code, {
      status: fails.length ? "excluded" : "candidate",
      failedGate: fails[0]?.[0] ?? null,
      reasons: fails.map((f) => f[1]),
      denseStates,
      breakFlag,
    });
    if (!fails.length) passing.push(m);
  }

  passing
    .sort((a, b) => (b.weekly_vol ?? 0) - (a.weekly_vol ?? 0))
    .slice(0, t.topN)
    .forEach((m) => (out.get(m.item_code)!.status = "headline"));
  return out;
}

/** Items remaining after each gate, applied in order (for the funnel). */
export function funnelCounts(metrics: ItemMetrics[], evals: Map<number, Evaluation>) {
  const order: (Gate | null)[] = ["alive", "coverage", "states", "moving"];
  let remaining = metrics.length;
  const steps = [{ label: "All items in scope", count: remaining, dropped: 0 }];
  for (const g of order) {
    const dropped = metrics.filter((m) => evals.get(m.item_code)!.failedGate === g).length;
    remaining -= dropped;
    steps.push({ label: GATES.find((x) => x.key === g)!.label, count: remaining, dropped });
  }
  return steps;
}
