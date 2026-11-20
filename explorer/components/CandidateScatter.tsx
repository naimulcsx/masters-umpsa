"use client";

import type { EChartsOption, ScatterSeriesOption } from "echarts";
import { useRouter } from "next/navigation";
import { useEffect, useMemo } from "react";
import type { Evaluation, ItemMetrics, Status, Thresholds } from "@/lib/candidates";
import { itemLabel, type Item } from "@/lib/shared";
import type { ChartTheme } from "@/lib/theme";
import { downloadDataURL, useEChart } from "./useEChart";

interface Props {
  metrics: ItemMetrics[];
  evals: Map<number, Evaluation>;
  items: Map<number, Item>;
  thresholds: Thresholds;
  theme: ChartTheme;
}

export const STATUS_LABEL: Record<Status, string> = {
  headline: "Top volatile candidate",
  candidate: "Candidate",
  excluded: "Excluded",
};

export function statusColor(s: Status, t: ChartTheme) {
  return s === "headline" ? t.series[1] : s === "candidate" ? t.series[0] : t.muted;
}

// Deterministic horizontal jitter so items with the same dense-state count don't stack.
const jitter = (code: number) => ((((code * 9301 + 49297) % 233280) / 233280) - 0.5) * 0.56;

export function CandidateScatter({ metrics, evals, items, thresholds, theme: t }: Props) {
  const router = useRouter();

  const option = useMemo<EChartsOption>(() => {
    const plotted = metrics.filter((m) => m.weekly_vol != null);
    const passingVol = plotted.filter((m) => evals.get(m.item_code)!.status !== "excluded").map((m) => m.weekly_vol!);
    const yMax = Math.max(0.02, ...(passingVol.length ? passingVol : plotted.map((m) => m.weekly_vol!))) * 1.25 * 100;

    const make = (status: Status, z: number): ScatterSeriesOption => ({
      type: "scatter",
      name: STATUS_LABEL[status],
      z,
      symbolSize: status === "excluded" ? 7 : 9,
      itemStyle: {
        color: statusColor(status, t),
        opacity: status === "excluded" ? 0.45 : 1,
        borderColor: t.surface,
        borderWidth: 1.5,
      },
      emphasis: { scale: 1.4, itemStyle: { borderColor: t.ink, borderWidth: 1.5 } },
      data: plotted
        .filter((m) => evals.get(m.item_code)!.status === status)
        .map((m) => {
          const e = evals.get(m.item_code)!;
          const v = m.weekly_vol! * 100;
          return {
            value: [e.denseStates + jitter(m.item_code), Math.min(v, yMax)],
            itemId: m.item_code,
            symbol: v > yMax ? "triangle" : "circle",
          };
        }),
    });

    return {
      backgroundColor: "transparent",
      textStyle: { fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif" },
      grid: { left: 8, right: 24, top: 28, bottom: 30, containLabel: true },
      xAxis: {
        type: "value",
        // Integer ticks from -1 to 17 (labels shown for 0, 2, …, 16) leave room for the jitter.
        min: -1,
        max: 17,
        interval: 1,
        name: "Dense states (of 16)",
        nameLocation: "middle",
        nameGap: 26,
        nameTextStyle: { color: t.muted },
        axisLine: { lineStyle: { color: t.axis } },
        axisTick: { show: false },
        axisLabel: { color: t.muted, formatter: (v: number) => (v >= 0 && v <= 16 && v % 2 === 0 ? String(v) : "") },
        splitLine: { show: false },
      },
      yAxis: {
        type: "value",
        min: 0,
        max: Math.ceil(yMax),
        name: "Weekly volatility (%)",
        nameTextStyle: { color: t.muted, align: "left" },
        axisLine: { show: false },
        axisLabel: { color: t.muted },
        splitLine: { lineStyle: { color: t.grid } },
      },
      tooltip: {
        trigger: "item",
        backgroundColor: t.surface,
        borderColor: t.grid,
        textStyle: { color: t.ink, fontSize: 12 },
        extraCssText: "box-shadow:0 4px 16px rgba(0,0,0,.12);border-radius:8px;max-width:320px;white-space:normal;",
        formatter: (raw) => {
          const p = Array.isArray(raw) ? raw[0] : raw;
          const code = (p.data as { itemId: number }).itemId;
          const m = metrics.find((x) => x.item_code === code)!;
          const e = evals.get(code)!;
          const it = items.get(code);
          const name = it ? itemLabel(it) : `Item ${code}`;
          let html = `<div style="font-weight:600">${name}</div>`;
          html += `<div style="color:${t.muted}">${it?.item_category ?? ""} · #${code}</div>`;
          html += `<div style="margin-top:4px">${STATUS_LABEL[e.status]}${e.reasons.length ? `: ${e.reasons.join("; ")}` : ""}</div>`;
          html += `<div style="color:${t.ink2}">${e.denseStates}/16 dense states · moves in ${Math.round((m.change_rate ?? 0) * 100)}% of weeks · ${((m.weekly_vol ?? 0) * 100).toFixed(1)}%/wk</div>`;
          html += `<div style="color:${t.muted};margin-top:4px">Click to open in the price explorer</div>`;
          return html;
        },
      },
      series: [
        {
          ...make("excluded", 1),
          markLine: {
            silent: true,
            symbol: ["none", "none"],
            lineStyle: { color: t.ink2, width: 1, type: "solid" },
            label: { formatter: `min ${thresholds.minDenseStates}`, color: t.muted, position: "end" },
            data: [{ xAxis: thresholds.minDenseStates - 0.5 }],
          },
        },
        make("candidate", 5),
        make("headline", 10),
      ],
    };
  }, [metrics, evals, items, thresholds.minDenseStates, t]);

  const { elRef, chartRef } = useEChart(option);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const onClick = (p: { data?: unknown }) => {
      const code = (p.data as { itemId?: number } | undefined)?.itemId;
      if (code != null) router.push(`/?item=${code}`);
    };
    chart.on("click", onClick);
    return () => {
      chart.off("click", onClick);
    };
  }, [chartRef, router]);

  return (
    <div className="card">
      <div className="card-head">
        <div className="legend">
          {(["headline", "candidate", "excluded"] as Status[]).map((s) => (
            <span key={s} className="legend-item">
              <i className="sw-dot" style={{ background: statusColor(s, t), opacity: s === "excluded" ? 0.6 : 1 }} />
              {s === "headline" ? `Top ${thresholds.topN} most volatile` : STATUS_LABEL[s]}
            </span>
          ))}
        </div>
        <button
          className="btn ghost"
          onClick={() => {
            const url = chartRef.current?.getDataURL({ pixelRatio: 2, backgroundColor: t.surface });
            if (url) downloadDataURL(url, "forecasting-candidates-scatter.png");
          }}
        >
          Download PNG
        </button>
      </div>
      <div ref={elRef} className="chart" style={{ height: 380 }} role="img" aria-label="Data strength versus price volatility per item" />
      <p className="hint">
        Right = more states with dense data; up = bigger typical weekly price moves. Triangles are clipped outliers. Click
        a dot to open the item.
      </p>
    </div>
  );
}
