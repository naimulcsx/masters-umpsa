"use client";

import type { EChartsOption } from "echarts";
import { useMemo } from "react";
import { BREAK_PERIOD, MIN_PREMISES, STATES, fmtMonth, fmtPct, fmtRM, type SeriesRow } from "@/lib/shared";
import type { ChartTheme } from "@/lib/theme";
import { downloadDataURL, useEChart } from "./useEChart";

interface Props {
  rows: SeriesRow[]; // monthly rows
  national: string;
  inRange: (period: string) => boolean;
  theme: ChartTheme;
  fileBase: string;
}

interface Cell {
  state: string;
  period: string;
  median: number;
  nat: number;
  premium: number;
  n: number;
}

export function StateHeatmap({ rows, national, inRange, theme: t, fileBase }: Props) {
  const { option, bound, empty } = useMemo(() => {
    const nat = new Map<string, number>();
    for (const r of rows) if (r.state === national && inRange(r.period)) nat.set(r.period, r.median);
    const months = [...nat.keys()].sort();

    const cells = new Map<string, Cell[]>();
    for (const r of rows) {
      if (r.state === national || !inRange(r.period) || r.n_premises < MIN_PREMISES) continue;
      const n = nat.get(r.period);
      if (!n) continue;
      const c: Cell = { state: r.state, period: r.period, median: r.median, nat: n, premium: r.median / n - 1, n: r.n_premises };
      const list = cells.get(r.state) ?? [];
      list.push(c);
      cells.set(r.state, list);
    }

    // Most expensive states (on average over the range) at the top.
    const meanPremium = (s: string) => {
      const l = cells.get(s);
      return l?.length ? l.reduce((a, c) => a + c.premium, 0) / l.length : -Infinity;
    };
    const states = [...STATES].sort((a, b) => meanPremium(a) - meanPremium(b)); // y axis runs bottom → top

    // Symmetric colour bound from the 95th percentile of |premium|, in 5% steps.
    const abs = [...cells.values()].flat().map((c) => Math.abs(c.premium)).sort((a, b) => a - b);
    const p95 = abs.length ? abs[Math.floor(abs.length * 0.95)] : 0.1;
    const bound = Math.min(50, Math.max(5, Math.ceil((p95 * 100) / 5) * 5));

    const lookup = new Map<string, Cell>();
    const data: [number, number, number][] = [];
    states.forEach((s, y) => {
      for (const c of cells.get(s) ?? []) {
        const x = months.indexOf(c.period);
        lookup.set(`${x}:${y}`, c);
        data.push([x, y, Math.round(c.premium * 1000) / 10]);
      }
    });

    const option: EChartsOption = {
      backgroundColor: "transparent",
      textStyle: { fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif" },
      grid: { left: 8, right: 16, top: 56, bottom: 8, containLabel: true },
      xAxis: {
        type: "category",
        data: months.map(fmtMonth),
        axisLine: { lineStyle: { color: t.axis } },
        axisTick: { show: false },
        axisLabel: { color: t.muted, hideOverlap: true },
        splitArea: { show: false },
      },
      yAxis: {
        type: "category",
        data: states,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: t.ink2 },
      },
      visualMap: {
        type: "continuous",
        min: -bound,
        max: bound,
        orient: "horizontal",
        left: "center",
        top: 0,
        itemHeight: 220,
        itemWidth: 10,
        text: [`+${bound}% pricier`, `−${bound}% cheaper`],
        textStyle: { color: t.muted },
        inRange: { color: t.diverging },
        calculable: false,
      },
      tooltip: {
        trigger: "item",
        backgroundColor: t.surface,
        borderColor: t.grid,
        textStyle: { color: t.ink, fontSize: 12 },
        extraCssText: "box-shadow:0 4px 16px rgba(0,0,0,.12);border-radius:8px;",
        formatter: (raw) => {
          const prm = Array.isArray(raw) ? raw[0] : raw;
          const [x, y] = prm.value as [number, number, number];
          const c = lookup.get(`${x}:${y}`);
          if (!c) return "";
          return `<div style="font-weight:600">${c.state} · ${fmtMonth(c.period)}</div>
            <div>${fmtRM(c.median)} vs national ${fmtRM(c.nat)}</div>
            <div><b>${fmtPct(c.premium)}</b> <span style="color:${t.muted}">· ${c.n} premises</span></div>`;
        },
      },
      series: [
        {
          type: "heatmap",
          data,
          itemStyle: { borderColor: t.surface, borderWidth: 1.5, borderRadius: 2 },
          emphasis: { itemStyle: { borderColor: t.ink, borderWidth: 1 } },
          markLine: months.includes(BREAK_PERIOD)
            ? {
                silent: true,
                symbol: ["none", "none"],
                lineStyle: { color: t.ink2, width: 1, type: "solid" },
                label: { formatter: "Jul 2025", color: t.muted, position: "end" },
                data: [{ xAxis: fmtMonth(BREAK_PERIOD) }],
              }
            : undefined,
        },
      ],
    };
    return { option, bound, empty: data.length === 0 };
  }, [rows, national, inRange, t]);

  const { elRef, chartRef } = useEChart(option);

  return (
    <div className="card">
      <div className="card-head">
        <div className="legend">
          <span className="legend-item">
            Monthly state median relative to the national median. Blue = cheaper, red = pricier, grey ≈ same. Colour scale
            is clamped at ±{bound}%.
          </span>
        </div>
        <button
          className="btn ghost"
          onClick={() => {
            const url = chartRef.current?.getDataURL({ pixelRatio: 2, backgroundColor: t.surface });
            if (url) downloadDataURL(url, `${fileBase}-states.png`);
          }}
        >
          Download PNG
        </button>
      </div>
      {empty && <p className="hint">No state has enough premises reporting this item in the selected range.</p>}
      <div ref={elRef} className="chart" style={{ height: 520 }} role="img" aria-label="State price premium heatmap" />
      <p className="hint">
        States ordered by average premium (most expensive at top). Blank cells: no data or fewer than {MIN_PREMISES}{" "}
        premises that month.
      </p>
    </div>
  );
}
