"use client";

import type { EChartsOption, LineSeriesOption } from "echarts";
import { useMemo } from "react";
import {
  BREAK_PERIOD,
  MIN_PREMISES,
  STATES,
  fmtCount,
  fmtPct,
  fmtPeriod,
  fmtRM,
  type Grain,
  type SeriesRow,
} from "@/lib/shared";
import type { ChartTheme } from "@/lib/theme";
import { downloadDataURL, useEChart } from "./useEChart";

interface Props {
  rows: SeriesRow[];
  grain: Grain;
  national: string;
  selected: { state: string; color: string }[];
  showContext: boolean;
  hideThin: boolean;
  showBand: boolean;
  inRange: (period: string) => boolean;
  unit: string;
  theme: ChartTheme;
  fileBase: string;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

export function TrendChart(p: Props) {
  const { rows, grain, national, selected, showContext, hideThin, showBand, inRange, unit, theme: t } = p;

  const option = useMemo<EChartsOption>(() => {
    // Index rows by state → period, and collect the shared period axis.
    const byState = new Map<string, Map<string, SeriesRow>>();
    const periodSet = new Set<string>();
    for (const r of rows) {
      if (!inRange(r.period)) continue;
      periodSet.add(r.period);
      let m = byState.get(r.state);
      if (!m) byState.set(r.state, (m = new Map()));
      m.set(r.period, r);
    }
    const periods = [...periodSet].sort();
    const usable = (r: SeriesRow | undefined) => !!r && (!hideThin || r.n_premises >= MIN_PREMISES);
    // Every series shares the same period list, so missing periods become
    // explicit gaps (null) instead of being bridged by a straight line.
    const values = (state: string) => {
      const m = byState.get(state);
      return periods.map((per) => {
        const r = m?.get(per);
        return [per, usable(r) ? r!.median : null] as [string, number | null];
      });
    };

    const selectedSet = new Set(selected.map((s) => s.state));
    const series: LineSeriesOption[] = [];
    const base: LineSeriesOption = {
      type: "line",
      showSymbol: false,
      symbol: "none",
      connectNulls: false,
      emphasis: { disabled: true },
      animationDuration: 250,
    };

    if (showContext) {
      for (const st of STATES) {
        if (selectedSet.has(st)) continue;
        series.push({
          ...base,
          id: `ctx:${st}`,
          name: st,
          data: values(st),
          silent: true,
          z: 1,
          lineStyle: { width: 1, color: t.context },
          itemStyle: { color: t.context },
        });
      }
    }

    const nat = byState.get(national);
    if (showBand && nat) {
      const band = periods.map((per) => nat.get(per));
      series.push({
        ...base,
        id: "band:lo",
        name: "band-lo",
        stack: "band",
        silent: true,
        z: 2,
        lineStyle: { opacity: 0 },
        data: band.map((r, i) => [periods[i], r ? r.p25 : null]),
      });
      series.push({
        ...base,
        id: "band:hi",
        name: "band-hi",
        stack: "band",
        silent: true,
        z: 2,
        lineStyle: { opacity: 0 },
        areaStyle: { color: t.band, opacity: 1 },
        data: band.map((r, i) => [periods[i], r ? r.p75 - r.p25 : null]),
      });
    }

    const breakVisible = periods.length > 0 && periods[0] <= BREAK_PERIOD && periods.at(-1)! >= BREAK_PERIOD;
    series.push({
      ...base,
      id: `nat:${national}`,
      name: national,
      data: values(national),
      z: 10,
      lineStyle: { width: 2.5, color: t.ink },
      itemStyle: { color: t.ink },
      endLabel: { show: true, formatter: national, color: t.ink, fontSize: 11, fontWeight: 600, distance: 6 },
      markLine: breakVisible
        ? {
            silent: true,
            symbol: ["none", "none"],
            lineStyle: { color: t.muted, width: 1, type: "solid" },
            label: {
              formatter: "Jul 2025 · basket & panel change",
              position: "end",
              color: t.muted,
              fontSize: 11,
            },
            data: [{ xAxis: BREAK_PERIOD }],
          }
        : undefined,
    });

    for (const s of selected) {
      series.push({
        ...base,
        id: `st:${s.state}`,
        name: s.state,
        data: values(s.state),
        z: 5,
        lineStyle: { width: 2, color: s.color },
        itemStyle: { color: s.color },
        endLabel: { show: true, formatter: s.state, color: t.ink2, fontSize: 11, distance: 6 },
      });
    }

    const swatch = (c: string, line = true) =>
      `<span style="display:inline-block;width:10px;height:${line ? 3 : 10}px;border-radius:2px;background:${c};margin-right:6px;vertical-align:middle"></span>`;

    return {
      backgroundColor: "transparent",
      textStyle: { fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif" },
      grid: { left: 8, right: 150, top: 40, bottom: 64, containLabel: true },
      xAxis: {
        type: "time",
        axisLine: { lineStyle: { color: t.axis } },
        axisTick: { show: false },
        axisLabel: { color: t.muted, hideOverlap: true },
        splitLine: { show: false },
      },
      yAxis: {
        type: "value",
        scale: true,
        name: `RM per ${unit}`,
        nameTextStyle: { color: t.muted, align: "left" },
        axisLine: { show: false },
        axisLabel: { color: t.muted, formatter: (v: number) => v.toFixed(2) },
        splitLine: { lineStyle: { color: t.grid, width: 1 } },
      },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "line", lineStyle: { color: t.muted, width: 1, type: "solid" } },
        backgroundColor: t.surface,
        borderColor: t.grid,
        textStyle: { color: t.ink, fontSize: 12 },
        extraCssText: "box-shadow:0 4px 16px rgba(0,0,0,.12);border-radius:8px;",
        formatter: (raw) => {
          const params = Array.isArray(raw) ? raw : [raw];
          const idx = params[0]?.dataIndex;
          if (idx == null) return "";
          const per = periods[idx];
          const natRow = nat?.get(per);
          const natMed = usable(natRow) ? natRow!.median : null;
          let html = `<div style="font-weight:600;margin-bottom:6px">${fmtPeriod(per, grain)}</div>`;
          if (natRow) {
            html += `<div>${swatch(t.ink)}<b>${esc(national)}</b> ${fmtRM(natRow.median)}</div>`;
            html += `<div style="color:${t.muted};margin:0 0 6px 16px">IQR ${fmtRM(natRow.p25)}–${natRow.p75.toFixed(2)} · ${fmtCount(natRow.n_premises)} premises</div>`;
          }
          const lines = selected
            .map((s) => ({ ...s, r: byState.get(s.state)?.get(per) }))
            .sort((a, b) => (b.r?.median ?? -Infinity) - (a.r?.median ?? -Infinity));
          for (const { state, color, r } of lines) {
            if (!r) {
              html += `<div style="color:${t.muted}">${swatch(color)}${esc(state)} – no data</div>`;
              continue;
            }
            const thin = r.n_premises < MIN_PREMISES;
            const diff = natMed ? ` <span style="color:${t.muted}">${fmtPct(r.median / natMed - 1)}</span>` : "";
            html += `<div${thin ? ` style="opacity:.55"` : ""}>${swatch(color)}${esc(state)} <b>${fmtRM(r.median)}</b>${diff}`;
            html += ` <span style="color:${t.muted}">· ${r.n_premises} prem.${thin ? " (thin)" : ""}</span></div>`;
          }
          return html;
        },
      },
      dataZoom: [
        { type: "inside", xAxisIndex: 0, filterMode: "none" },
        {
          type: "slider",
          xAxisIndex: 0,
          height: 22,
          bottom: 10,
          filterMode: "none",
          borderColor: t.grid,
          backgroundColor: "transparent",
          fillerColor: t.band,
          dataBackground: { lineStyle: { color: t.axis }, areaStyle: { color: t.grid } },
          selectedDataBackground: { lineStyle: { color: t.muted }, areaStyle: { color: t.axis } },
          handleStyle: { color: t.surface, borderColor: t.muted },
          moveHandleStyle: { color: t.axis },
          textStyle: { color: t.muted },
          labelFormatter: (_v: number, s: string) => s.slice(0, 10),
        },
      ],
      labelLayout: { moveOverlap: "shiftY" },
      series,
    };
  }, [rows, grain, national, selected, showContext, hideThin, showBand, inRange, unit, t]);

  const { elRef, chartRef } = useEChart(option);

  return (
    <div className="card">
      <div className="card-head">
        <div className="legend" aria-label="Legend">
          <span className="legend-item">
            <i className="sw-line" style={{ background: t.ink, height: 3 }} />
            {national} (national median)
          </span>
          {showBand && (
            <span className="legend-item">
              <i className="sw-box" style={{ background: t.band, outline: `1px solid ${t.grid}` }} />
              National middle 50% of premises
            </span>
          )}
          {selected.map((s) => (
            <span key={s.state} className="legend-item">
              <i className="sw-line" style={{ background: s.color }} />
              {s.state}
            </span>
          ))}
          {showContext && (
            <span className="legend-item">
              <i className="sw-line" style={{ background: t.context }} />
              Other states
            </span>
          )}
        </div>
        <button
          className="btn ghost"
          onClick={() => {
            const url = chartRef.current?.getDataURL({ pixelRatio: 2, backgroundColor: t.surface });
            if (url) downloadDataURL(url, `${p.fileBase}-trend.png`);
          }}
        >
          Download PNG
        </button>
      </div>
      <div ref={elRef} className="chart" style={{ height: 480 }} role="img" aria-label="Price over time by state" />
      <p className="hint">
        Scroll or drag the slider to zoom. Each point is the median across premises of each premise&apos;s mean price in
        the {grain}.
        {hideThin && ` Points from fewer than ${MIN_PREMISES} premises are hidden.`}
      </p>
    </div>
  );
}
