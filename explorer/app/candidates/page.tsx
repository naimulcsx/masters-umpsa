import type { Metadata } from "next";
import { Candidates, type Scope } from "@/components/Candidates";
import { DEFAULT_THRESHOLDS, type Thresholds } from "@/lib/candidates";
import { loadItems, loadMetrics } from "@/lib/data";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Forecasting candidates · PriceCatcher Explorer" };

type Search = Record<string, string | string[] | undefined>;

function num(v: string | string[] | undefined, min: number, max: number, dflt: number): number {
  const n = Number(Array.isArray(v) ? v[0] : v);
  return v === undefined || !Number.isFinite(n) ? dflt : Math.min(max, Math.max(min, n));
}

export default async function Page({ searchParams }: { searchParams: Promise<Search> }) {
  const [meta, metrics] = await Promise.all([loadItems(), loadMetrics()]);
  if (!meta || !metrics) {
    return (
      <main className="empty">
        <h1>No metrics yet</h1>
        <p>
          From the repo root, run <code>npm run build:cube</code> (or <code>node scripts/build-cube.mjs --metrics-only</code>{" "}
          if the cube already exists), then reload.
        </p>
      </main>
    );
  }
  const sp = await searchParams;
  const d = DEFAULT_THRESHOLDS;
  const thresholds: Thresholds = {
    ...d,
    minCoverage: num(sp.cov, 50, 100, d.minCoverage * 100) / 100,
    minDensity: num(sp.dens, 50, 100, d.minDensity * 100) / 100,
    minDenseStates: num(sp.states, 0, 16, d.minDenseStates),
    minChangeRate: num(sp.chg, 0, 100, d.minChangeRate * 100) / 100,
    topN: num(sp.top, 5, 50, d.topN),
  };
  const scope: Scope = sp.scope === "all" ? "all" : "fresh";
  return <Candidates meta={meta} metrics={metrics} initial={{ thresholds, scope }} />;
}
