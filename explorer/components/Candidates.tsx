"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  BREAK_FLAG,
  DEFAULT_THRESHOLDS,
  evaluateAll,
  funnelCounts,
  type Evaluation,
  type ItemMetrics,
  type MetricsFile,
  type Status,
  type Thresholds,
} from "@/lib/candidates";
import { FRESH_GROUP, fmtMonth, fmtPct, itemLabel, type Item, type ItemsFile } from "@/lib/shared";
import { useChartTheme } from "@/lib/theme";
import { CandidateScatter, STATUS_LABEL, statusColor } from "./CandidateScatter";
import { Sparkline } from "./Sparkline";

export type Scope = "fresh" | "all";

interface Props {
  meta: ItemsFile;
  metrics: MetricsFile;
  initial: { thresholds: Thresholds; scope: Scope };
}

type SortKey =
  | "status"
  | "item"
  | "coverage"
  | "dense"
  | "change_rate"
  | "weekly_vol"
  | "seasonal_strength"
  | "spectral_entropy"
  | "break_shift"
  | "avg_premises";

const STATUS_RANK: Record<Status, number> = { headline: 0, candidate: 1, excluded: 2 };

interface Row {
  m: ItemMetrics;
  e: Evaluation;
  it: Item | undefined;
  name: string;
}

function Slider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="slider">
      <span className="slider-label">
        {props.label} <b>{props.format(props.value)}</b>
      </span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
    </label>
  );
}

/** Thin bar showing a value relative to the column's scale. */
function Bar({ frac, fail }: { frac: number; fail?: boolean }) {
  return (
    <span className={`minibar${fail ? " fail" : ""}`}>
      <span style={{ width: `${Math.max(0, Math.min(1, frac)) * 100}%` }} />
    </span>
  );
}

const pct0 = (v: number | null) => (v == null ? "–" : `${Math.round(v * 100)}%`);

export function Candidates({ meta, metrics, initial }: Props) {
  const theme = useChartTheme();
  const [t, setT] = useState<Thresholds>(initial.thresholds);
  const [scope, setScope] = useState<Scope>(initial.scope);
  const [query, setQuery] = useState("");
  const [show, setShow] = useState<"all" | Status>("all");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "status", dir: 1 });

  const items = useMemo(() => new Map(meta.items.map((i) => [i.item_code, i])), [meta.items]);
  const inScope = useMemo(
    () => metrics.items.filter((m) => scope === "all" || items.get(m.item_code)?.item_group === FRESH_GROUP),
    [metrics.items, items, scope],
  );
  const evals = useMemo(() => evaluateAll(inScope, t, metrics.lastWeek), [inScope, t, metrics.lastWeek]);
  const funnel = useMemo(() => funnelCounts(inScope, evals), [inScope, evals]);

  useEffect(() => {
    const q = new URLSearchParams({
      scope,
      cov: String(Math.round(t.minCoverage * 100)),
      dens: String(Math.round(t.minDensity * 100)),
      states: String(t.minDenseStates),
      chg: String(Math.round(t.minChangeRate * 100)),
      top: String(t.topN),
    });
    window.history.replaceState(null, "", `?${q}`);
  }, [t, scope]);

  const rows: Row[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = inScope
      .map((m) => {
        const it = items.get(m.item_code);
        return { m, e: evals.get(m.item_code)!, it, name: it ? itemLabel(it) : `Item ${m.item_code}` };
      })
      .filter((r) => show === "all" || r.e.status === show)
      .filter(
        (r) =>
          !q ||
          r.name.toLowerCase().includes(q) ||
          String(r.m.item_code).includes(q) ||
          (r.it?.item_category ?? "").toLowerCase().includes(q),
      );
    const val = (r: Row): number | string => {
      switch (sort.key) {
        case "status":
          return STATUS_RANK[r.e.status];
        case "item":
          return r.name;
        case "dense":
          return r.e.denseStates;
        case "coverage":
          return r.m.coverage;
        case "avg_premises":
          return r.m.avg_premises;
        case "break_shift":
          return r.m.break_shift == null ? -1 : Math.abs(r.m.break_shift);
        default:
          return r.m[sort.key] ?? -1;
      }
    };
    return list.sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      const c = typeof va === "string" ? va.localeCompare(vb as string) : va - (vb as number);
      // Ties (and the default status sort) fall back to volatility, highest first.
      return c * sort.dir || (b.m.weekly_vol ?? -1) - (a.m.weekly_vol ?? -1);
    });
  }, [inScope, items, evals, show, query, sort]);

  const counts = useMemo(() => {
    const c = { headline: 0, candidate: 0, excluded: 0 };
    for (const e of evals.values()) c[e.status]++;
    return c;
  }, [evals]);

  const maxVol = Math.max(0.01, ...rows.filter((r) => r.e.status !== "excluded").map((r) => r.m.weekly_vol ?? 0));

  const th = (key: SortKey, label: string, title?: string, defaultDir: 1 | -1 = -1) => (
    <th
      title={title}
      aria-sort={sort.key === key ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
    >
      <button
        className="th-btn"
        onClick={() => setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: defaultDir }))}
      >
        {label}
        {sort.key === key ? (sort.dir === 1 ? " ↑" : " ↓") : ""}
      </button>
    </th>
  );

  const downloadCSV = () => {
    const header = [
      "item_code", "item", "unit", "category", "status", "reasons", "first_week", "last_week", "coverage",
      "dense_states", "change_rate", "weekly_vol", "cv", "seasonal_strength", "spectral_entropy",
      "break_shift", "break_premises", "avg_premises",
    ];
    const q = (s: string) => `"${s.replaceAll('"', '""')}"`;
    const lines = rows.map((r) =>
      [
        r.m.item_code, q(r.name), q(r.it?.unit ?? ""), q(r.it?.item_category ?? ""), r.e.status,
        q(r.e.reasons.join("; ")), r.m.first_period ?? "", r.m.last_period ?? "", r.m.coverage, r.e.denseStates,
        r.m.change_rate ?? "", r.m.weekly_vol ?? "", r.m.cv ?? "", r.m.seasonal_strength ?? "",
        r.m.spectral_entropy ?? "", r.m.break_shift ?? "", r.m.break_premises ?? "", r.m.avg_premises,
      ].join(","),
    );
    const blob = new Blob([[header.join(","), ...lines].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `candidates_${scope}_cov${Math.round(t.minCoverage * 100)}_dens${Math.round(t.minDensity * 100)}_st${t.minDenseStates}_chg${Math.round(t.minChangeRate * 100)}_top${t.topN}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const set = <K extends keyof Thresholds>(k: K) => (v: Thresholds[K]) => setT((cur) => ({ ...cur, [k]: v }));
  const isDefault = JSON.stringify(t) === JSON.stringify(DEFAULT_THRESHOLDS);
  const top = funnel[0].count || 1;

  return (
    <main className="page">
      <header className="page-head">
        <div>
          <Link href="/" className="back">
            ← Price explorer
          </Link>
          <h1>Forecasting candidates</h1>
          <p className="sub">
            Which items have enough clean, moving price history to forecast at item × state × week level? Each item must
            pass four checks in order; those that pass are ranked by how much their price moves.
          </p>
        </div>
      </header>

      <section className="filters" aria-label="Thresholds">
        <div className="filter-row">
          <div className="seg" role="radiogroup" aria-label="Item scope">
            <button role="radio" aria-checked={scope === "fresh"} onClick={() => setScope("fresh")}>
              Fresh produce
            </button>
            <button role="radio" aria-checked={scope === "all"} onClick={() => setScope("all")}>
              All items
            </button>
          </div>
          <span className="muted small">
            Still reported = data in the last {t.aliveWeeks} weeks (through week of {metrics.lastWeek}).
          </span>
          <span className="spacer" />
          {!isDefault && (
            <button className="btn ghost small" onClick={() => setT(DEFAULT_THRESHOLDS)}>
              Reset thresholds
            </button>
          )}
        </div>
        <div className="sliders">
          <Slider
            label="Complete history: national data in ≥"
            value={Math.round(t.minCoverage * 100)}
            min={50}
            max={100}
            step={1}
            format={(v) => `${v}% of weeks`}
            onChange={(v) => set("minCoverage")(v / 100)}
          />
          <Slider
            label="A state is dense if it has ≥3 premises in ≥"
            value={Math.round(t.minDensity * 100)}
            min={50}
            max={100}
            step={1}
            format={(v) => `${v}% of weeks`}
            onChange={(v) => set("minDensity")(v / 100)}
          />
          <Slider
            label="Enough dense states: at least"
            value={t.minDenseStates}
            min={0}
            max={16}
            step={1}
            format={(v) => `${v} of 16`}
            onChange={set("minDenseStates")}
          />
          <Slider
            label="Price moves: national median changes in ≥"
            value={Math.round(t.minChangeRate * 100)}
            min={0}
            max={100}
            step={5}
            format={(v) => `${v}% of weeks`}
            onChange={(v) => set("minChangeRate")(v / 100)}
          />
          <Slider
            label="Headline set: the most volatile"
            value={t.topN}
            min={5}
            max={50}
            step={5}
            format={(v) => `${v} candidates`}
            onChange={set("topN")}
          />
        </div>
      </section>

      <div className="cand-grid">
        <div className="card">
          <h2 className="card-title">How many items survive each check</h2>
          <ol className="funnel">
            {funnel.map((s, i) => (
              <li key={s.label}>
                <span className="funnel-label">
                  {i > 0 && <span className="muted">{i}. </span>}
                  {s.label}
                </span>
                <span className="funnel-bar">
                  <span style={{ width: `${(s.count / top) * 100}%`, background: theme.series[0] }} />
                </span>
                <span className="funnel-count">
                  <b>{s.count}</b>
                  {s.dropped > 0 && <span className="muted"> −{s.dropped}</span>}
                </span>
              </li>
            ))}
          </ol>
          <p className="funnel-result">
            <b>{counts.candidate + counts.headline}</b> candidates, including the <b>{counts.headline}</b> most volatile
            as the headline set. Each item is counted at the first check it fails.
          </p>
        </div>
        <CandidateScatter metrics={inScope} evals={evals} items={items} thresholds={t} theme={theme} />
      </div>

      <div className="card">
        <div className="card-head">
          <div className="filter-row">
            <div className="seg" role="radiogroup" aria-label="Status filter">
              {(["all", "headline", "candidate", "excluded"] as const).map((s) => (
                <button key={s} role="radio" aria-checked={show === s} onClick={() => setShow(s)}>
                  {s === "all" ? "All" : s === "headline" ? `Top ${t.topN}` : s === "candidate" ? "Other candidates" : "Excluded"}{" "}
                  <span className="muted">
                    {s === "all" ? inScope.length : counts[s]}
                  </span>
                </button>
              ))}
            </div>
            <input
              className="search inline"
              type="search"
              placeholder="Search item, category or code…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search items"
            />
          </div>
          <button className="btn ghost" onClick={downloadCSV}>
            Download CSV
          </button>
        </div>
        <div className="table-wrap tall">
          <table className="data cand">
            <thead>
              <tr>
                {th("item", "Item", undefined, 1)}
                {th("status", "Status", "Top volatile candidates first, then other candidates, then excluded", 1)}
                <th>National price</th>
                {th("coverage", "History", "Share of weeks since Jan 2022 with a usable national median")}
                {th("dense", "Dense states", "States with ≥3 premises in enough weeks")}
                {th("change_rate", "Price moves", "Share of weeks in which the national median changed")}
                {th("weekly_vol", "Volatility", "Typical weekly price move (std. dev. of weekly log changes)")}
                {th("seasonal_strength", "Seasonality", "Strength of the yearly pattern, 0–1 (Hyndman F_S)")}
                {th("spectral_entropy", "Entropy", "Spectral entropy of weekly changes, 0–1; lower = more regular structure", 1)}
                {th("break_shift", "Jul 2025 shift", "Level change at the July 2025 basket/panel change, net of the usual seasonal move")}
                {th("avg_premises", "Premises", "Average premises reporting nationally per week")}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ m, e, it, name }) => {
                const failed = new Set(e.reasons.length ? [e.failedGate] : []);
                // Mark every failing metric, not only the first.
                if (m.coverage < t.minCoverage) failed.add("coverage");
                if (e.denseStates < t.minDenseStates) failed.add("states");
                if ((m.change_rate ?? 0) < t.minChangeRate) failed.add("moving");
                return (
                  <tr key={m.item_code} className={e.status === "excluded" ? "dim" : undefined}>
                    <td className="item-cell">
                      <div className="stack">
                        <Link href={`/?item=${m.item_code}`}>{name}</Link>
                        <span className="muted small">
                          {it?.unit} · {it?.item_category ?? "—"} · #{m.item_code}
                        </span>
                      </div>
                    </td>
                    <td className="status-cell">
                      <div className="stack">
                        <span className="status">
                          <i className="sw-dot" style={{ background: statusColor(e.status, theme) }} />
                          {e.status === "headline" ? `Top ${t.topN}` : STATUS_LABEL[e.status]}
                        </span>
                        {e.reasons.length > 0 && <span className="muted small">{e.reasons.join("; ")}</span>}
                      </div>
                    </td>
                    <td>
                      <Sparkline values={m.spark ?? []} months={metrics.months} />
                    </td>
                    <td className={`num${failed.has("coverage") ? " fail-text" : ""}`}>
                      {pct0(m.coverage)}
                      <Bar frac={m.coverage} fail={failed.has("coverage")} />
                    </td>
                    <td className={`num${failed.has("states") ? " fail-text" : ""}`}>
                      {e.denseStates}/16
                      <Bar frac={e.denseStates / 16} fail={failed.has("states")} />
                    </td>
                    <td className={`num${failed.has("moving") ? " fail-text" : ""}`}>
                      {pct0(m.change_rate)}
                      <Bar frac={m.change_rate ?? 0} fail={failed.has("moving")} />
                    </td>
                    <td className="num">
                      {m.weekly_vol == null ? "–" : `${(m.weekly_vol * 100).toFixed(1)}%`}
                      <Bar frac={(m.weekly_vol ?? 0) / maxVol} />
                    </td>
                    <td className="num">
                      {m.seasonal_strength == null ? "–" : m.seasonal_strength.toFixed(2)}
                      <Bar frac={m.seasonal_strength ?? 0} />
                    </td>
                    <td className="num">{m.spectral_entropy == null ? "–" : m.spectral_entropy.toFixed(2)}</td>
                    <td className="num" title={m.break_premises ? `Premises ×${m.break_premises.toFixed(2)} across the break` : undefined}>
                      {m.break_shift == null ? "–" : fmtPct(m.break_shift)}
                      {e.breakFlag && <span className="flag" title={`Shift of ${BREAK_FLAG * 100}% or more`}> ⚑</span>}
                    </td>
                    <td className="num muted">{m.avg_premises.toLocaleString("en-US")}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length === 0 && <p className="hint pad">No items match.</p>}
        </div>
        <p className="hint">
          Red values fail a threshold. ⚑ = level shift of {BREAK_FLAG * 100}% or more at July 2025 (worth checking before
          training across the break). Click an item to open its price history.
        </p>
      </div>

      <details className="card methods">
        <summary>How each measure is computed</summary>
        <ul>
          <li>
            All measures use the <b>national weekly median</b> (Monday weeks, from {metrics.start}). A week counts only if
            at least {metrics.minPremises} premises reported the item. {metrics.weeks} weeks in total.
          </li>
          <li>
            <b>History</b>: share of those weeks with a usable national value. <b>Dense state</b>: a state with ≥
            {metrics.minPremises} premises in at least the chosen share of weeks.
          </li>
          <li>
            <b>Price moves</b>: share of consecutive weeks where the national median changed. Low values mean a sticky or
            ceiling-controlled price, which is trivially forecastable.
          </li>
          <li>
            <b>Volatility</b>: standard deviation of weekly log price changes, roughly the typical % move per week.
          </li>
          <li>
            <b>Seasonality</b>: Hyndman&apos;s seasonal strength F<sub>S</sub> = max(0, 1 − Var(R)/Var(S+R)) on monthly
            log prices, from a classical 2×12 moving-average decomposition.
          </li>
          <li>
            <b>Entropy</b>: normalised spectral entropy of weekly log changes (Daniell-smoothed periodogram), after Goerg
            (2013). 1 = white noise; lower = more regular structure for a model to learn. Only computed when history ≥
            90%.
          </li>
          <li>
            <b>Jul 2025 shift</b>: change in mean log price from Apr–Jun to Jul–Sep 2025, minus the same change from 2024,
            so the usual seasonal move is netted out.
          </li>
        </ul>
        <p className="muted small">
          Data through {meta.dataEnd}; months shown in sparklines: {fmtMonth(metrics.months[0])} –{" "}
          {fmtMonth(metrics.months.at(-1)!)}.
        </p>
      </details>
    </main>
  );
}
