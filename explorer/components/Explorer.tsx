"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BREAK_PERIOD,
  FRESH_GROUP,
  MAX_COMPARE,
  SPARSE_STATES,
  STATES,
  addMonths,
  fmtCount,
  fmtMonth,
  fmtPct,
  fmtRM,
  itemLabel,
  type Grain,
  type ItemsFile,
  type SeriesResponse,
  type SeriesRow,
} from "@/lib/shared";
import { DEFAULT_THRESHOLDS, evaluateAll, type ItemMetrics } from "@/lib/candidates";
import { useChartTheme } from "@/lib/theme";
import Link from "next/link";
import { statusColor } from "./CandidateScatter";
import { DataTable } from "./DataTable";
import { ItemList } from "./ItemList";
import { StateHeatmap } from "./StateHeatmap";
import { TrendChart } from "./TrendChart";

export type Tab = "trend" | "states" | "table";
export type RangeKey = "all" | "pre" | "post" | "24m" | "12m";

export interface InitialView {
  item: number;
  grain: Grain;
  states: string[];
  tab: Tab;
  range: RangeKey;
}

const RANGES: { key: RangeKey; label: string; title: string }[] = [
  { key: "all", label: "All", title: "Full history" },
  { key: "pre", label: "Before Jul 2025", title: "Up to the July 2025 basket & panel change" },
  { key: "post", label: "From Jul 2025", title: "From the July 2025 basket & panel change" },
  { key: "24m", label: "Last 24 mo", title: "Last 24 months" },
  { key: "12m", label: "Last 12 mo", title: "Last 12 months" },
];

const TABS: { key: Tab; label: string }[] = [
  { key: "trend", label: "Price over time" },
  { key: "states", label: "States vs national" },
  { key: "table", label: "Table" },
];

/** Selected states keep their palette slot until removed — colour follows the state, not its position. */
type Selection = { state: string; slot: number }[];

function withSlots(states: string[]): Selection {
  return states.slice(0, MAX_COMPARE).map((state, slot) => ({ state, slot }));
}

export function Explorer({
  meta,
  initial,
  metrics,
}: {
  meta: ItemsFile;
  initial: InitialView;
  metrics: { lastWeek: string; items: ItemMetrics[] } | null;
}) {
  const theme = useChartTheme();
  const national = meta.national;

  const [itemCode, setItemCode] = useState(initial.item);
  const [grain, setGrain] = useState<Grain>(initial.grain);
  const [selection, setSelection] = useState<Selection>(() => withSlots(initial.states));
  const [tab, setTab] = useState<Tab>(initial.tab);
  const [range, setRange] = useState<RangeKey>(initial.range);
  const [showContext, setShowContext] = useState(false);
  const [hideThin, setHideThin] = useState(true);
  const [showBand, setShowBand] = useState(true);

  const [data, setData] = useState<SeriesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cache = useRef(new Map<number, SeriesResponse>());

  const item = meta.items.find((i) => i.item_code === itemCode);

  // Forecasting readiness under the default candidate thresholds. Evaluated
  // within the item's own scope (fresh produce vs all) so the top-N ranking
  // matches the Candidates page.
  const readiness = useMemo(() => {
    if (!metrics) return null;
    const m = metrics.items.find((x) => x.item_code === itemCode);
    if (!m) return null;
    const fresh = item?.item_group === FRESH_GROUP;
    const groupOf = new Map(meta.items.map((i) => [i.item_code, i.item_group]));
    const scoped = metrics.items.filter((x) => !fresh || groupOf.get(x.item_code) === FRESH_GROUP);
    return { m, e: evaluateAll(scoped, DEFAULT_THRESHOLDS, metrics.lastWeek).get(itemCode)!, fresh };
  }, [metrics, itemCode, item, meta.items]);

  // Fetch the item's series (weekly + monthly, all states) — cached per item.
  useEffect(() => {
    const hit = cache.current.get(itemCode);
    if (hit) {
      setData(hit);
      setError(null);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    fetch(`/api/series?item=${itemCode}`, { signal: ctrl.signal })
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? res.statusText);
        cache.current.set(itemCode, body);
        setData(body);
        setError(null);
      })
      .catch((err) => {
        if (err.name !== "AbortError") setError(String(err.message ?? err));
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [itemCode]);

  // Mirror the view into the URL so a chart can be bookmarked / reproduced.
  useEffect(() => {
    const q = new URLSearchParams({
      item: String(itemCode),
      grain,
      states: selection.map((s) => s.state).join(","),
      tab,
      range,
    });
    window.history.replaceState(null, "", `?${q}`);
  }, [itemCode, grain, selection, tab, range]);

  const inRange = useCallback(
    (period: string) => {
      switch (range) {
        case "pre":
          return period < BREAK_PERIOD;
        case "post":
          return period >= BREAK_PERIOD;
        case "24m":
          return period >= addMonths(meta.dataEnd, -23);
        case "12m":
          return period >= addMonths(meta.dataEnd, -11);
        default:
          return true;
      }
    },
    [range, meta.dataEnd],
  );

  const selected = useMemo(
    () => selection.map((s) => ({ state: s.state, color: theme.series[s.slot] })),
    [selection, theme],
  );

  const toggleState = (state: string) =>
    setSelection((cur) => {
      if (cur.some((s) => s.state === state)) return cur.filter((s) => s.state !== state);
      if (cur.length >= MAX_COMPARE) return cur;
      const used = new Set(cur.map((s) => s.slot));
      const slot = [...Array(MAX_COMPARE).keys()].find((i) => !used.has(i))!;
      return [...cur, { state, slot }];
    });

  const fresh = data && data.item_code === itemCode ? data : null;
  const shown = fresh ?? data; // hold the previous item's render while loading
  const rows: SeriesRow[] = shown ? shown[grain] : [];

  const headline = useMemo(() => {
    if (!fresh) return null;
    const nat = fresh.month.filter((r) => r.state === national);
    const last = nat.at(-1);
    if (!last) return null;
    const yearAgo = nat.find((r) => r.period === addMonths(last.period, -12));
    return { last, change: yearAgo ? last.median / yearAgo.median - 1 : null };
  }, [fresh, national]);

  const fileBase = `pricecatcher-${itemCode}-${grain}-${range}`;

  const downloadCSV = () => {
    if (!shown || !item) return;
    const header = "item_code,item,unit,grain,state,period,median,p25,p75,n_premises,n_obs";
    const name = `"${itemLabel(item).replaceAll('"', '""')}"`;
    const lines = shown[grain]
      .filter((r) => inRange(r.period))
      .map((r) =>
        [item.item_code, name, item.unit ?? "", grain, `"${r.state}"`, r.period, r.median, r.p25, r.p75, r.n_premises, r.n_obs].join(","),
      );
    const blob = new Blob([[header, ...lines].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${fileBase}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="layout">
      <ItemList items={meta.items} selected={itemCode} onSelect={setItemCode} dataEndWeek={meta.dataEndWeek} />

      <main className="main">
        <header className="item-head">
          <div>
            <h1>{item ? itemLabel(item) : `Item ${itemCode}`}</h1>
            {item && (
              <p className="sub">
                {item.unit} · {item.item_group ?? "no group"} › {item.item_category ?? "no category"} · #{item.item_code}{" "}
                · {fmtMonth(item.first_period)} – {fmtMonth(item.last_period)} · {fmtCount(item.n_obs)} price
                observations
              </p>
            )}
            {readiness && (
              <p className="readiness">
                <span className="status">
                  <i className="sw-dot" style={{ background: statusColor(readiness.e.status, theme) }} />
                  {readiness.e.status === "headline"
                    ? `Top ${DEFAULT_THRESHOLDS.topN} volatile forecasting candidate`
                    : readiness.e.status === "candidate"
                      ? "Forecasting candidate"
                      : `Not a forecasting candidate: ${readiness.e.reasons.join("; ")}`}
                </span>
                <span className="muted">
                  {readiness.e.denseStates}/16 dense states · moves in{" "}
                  {Math.round((readiness.m.change_rate ?? 0) * 100)}% of weeks
                  {readiness.m.weekly_vol != null && ` · ${(readiness.m.weekly_vol * 100).toFixed(1)}%/wk volatility`}
                  {readiness.m.seasonal_strength != null &&
                    ` · seasonality ${readiness.m.seasonal_strength.toFixed(2)}`}
                  {readiness.e.breakFlag &&
                    readiness.m.break_shift != null &&
                    ` · ⚑ ${fmtPct(readiness.m.break_shift)} shift at Jul 2025`}
                </span>
                <Link href={readiness.fresh ? "/candidates" : "/candidates?scope=all"}>All candidates →</Link>
              </p>
            )}
          </div>
          {headline && (
            <div className="stat" aria-live="polite">
              <div className="stat-label">National median, {fmtMonth(headline.last.period)}</div>
              <div className="stat-value">{fmtRM(headline.last.median)}</div>
              {headline.change != null && (
                <div className="stat-sub">{fmtPct(headline.change)} vs 12 months earlier</div>
              )}
            </div>
          )}
        </header>

        {/* One filter row scopes every view below it. */}
        <section className="filters" aria-label="Filters">
          <div className="filter-row">
            <span className="filter-label">
              Compare states <span className="muted">(up to {MAX_COMPARE})</span>
            </span>
            <div className="chips">
              {STATES.map((st) => {
                const sel = selected.find((s) => s.state === st);
                const full = !sel && selection.length >= MAX_COMPARE;
                return (
                  <button
                    key={st}
                    className={`chip${sel ? " on" : ""}`}
                    aria-pressed={!!sel}
                    aria-label={SPARSE_STATES.has(st) ? `${st} (few premises)` : st}
                    disabled={full}
                    title={
                      full
                        ? `Remove a state first — at most ${MAX_COMPARE} can be coloured`
                        : SPARSE_STATES.has(st)
                          ? "Few premises report here — medians are noisy"
                          : undefined
                    }
                    onClick={() => toggleState(st)}
                  >
                    {sel && <i className="sw-dot" style={{ background: sel.color }} />}
                    {st}
                    {SPARSE_STATES.has(st) && <span className="muted"> ·</span>}
                  </button>
                );
              })}
              {selection.length > 0 && (
                <button className="btn ghost small" onClick={() => setSelection([])}>
                  Clear
                </button>
              )}
            </div>
          </div>
          <div className="filter-row">
            <div className="seg" role="radiogroup" aria-label="Time grain">
              {(["week", "month"] as Grain[]).map((g) => (
                <button key={g} role="radio" aria-checked={grain === g} onClick={() => setGrain(g)} disabled={tab === "states"}>
                  {g === "week" ? "Weekly" : "Monthly"}
                </button>
              ))}
            </div>
            <div className="seg" role="radiogroup" aria-label="Date range">
              {RANGES.map((r) => (
                <button key={r.key} role="radio" aria-checked={range === r.key} title={r.title} onClick={() => setRange(r.key)}>
                  {r.label}
                </button>
              ))}
            </div>
            <label className="check">
              <input type="checkbox" checked={showBand} onChange={(e) => setShowBand(e.target.checked)} /> National spread
            </label>
            <label className="check">
              <input type="checkbox" checked={showContext} onChange={(e) => setShowContext(e.target.checked)} /> Other
              states in grey
            </label>
            <label className="check">
              <input type="checkbox" checked={hideThin} onChange={(e) => setHideThin(e.target.checked)} /> Hide thin points
            </label>
          </div>
        </section>

        <nav className="tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
          <span className="spacer" />
          <button className="btn ghost" onClick={downloadCSV} disabled={!shown}>
            Download CSV
          </button>
        </nav>

        {error && <div className="error">Could not load this item: {error}</div>}

        <div className={`views${loading ? " loading" : ""}`}>
          {!shown && !error && <p className="hint pad">Loading…</p>}
          {shown && tab === "trend" && (
            <TrendChart
              rows={rows}
              grain={grain}
              national={national}
              selected={selected}
              showContext={showContext}
              hideThin={hideThin}
              showBand={showBand}
              inRange={inRange}
              unit={item?.unit ?? "unit"}
              theme={theme}
              fileBase={fileBase}
            />
          )}
          {shown && tab === "states" && (
            <StateHeatmap rows={shown.month} national={national} inRange={inRange} theme={theme} fileBase={fileBase} />
          )}
          {shown && tab === "table" && (
            <DataTable rows={rows} grain={grain} national={national} selected={selected} inRange={inRange} />
          )}
        </div>

        <footer className="foot">
          Data: OpenDOSM PriceCatcher via data.gov.my, through {meta.dataEnd}. Summary table built{" "}
          {new Date(meta.builtAt).toLocaleString("en-GB")}. The July 2025 marker flags the basket cut and premise panel
          change, so a jump there may come from which shops are counted rather than a real price change.
        </footer>
      </main>
    </div>
  );
}
