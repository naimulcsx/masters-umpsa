"use client";

import { useMemo } from "react";
import { MIN_PREMISES, fmtPeriod, type Grain, type SeriesRow } from "@/lib/shared";

interface Props {
  rows: SeriesRow[];
  grain: Grain;
  national: string;
  selected: { state: string; color: string }[];
  inRange: (period: string) => boolean;
}

/** Table twin of the trend chart: every plotted value, newest first. */
export function DataTable({ rows, grain, national, selected, inRange }: Props) {
  const { periods, get } = useMemo(() => {
    const m = new Map<string, SeriesRow>();
    const ps = new Set<string>();
    for (const r of rows) {
      if (!inRange(r.period)) continue;
      ps.add(r.period);
      m.set(`${r.state}|${r.period}`, r);
    }
    return {
      periods: [...ps].sort().reverse(),
      get: (state: string, period: string) => m.get(`${state}|${period}`),
    };
  }, [rows, inRange]);

  return (
    <div className="card">
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>{grain === "week" ? "Week" : "Month"}</th>
              <th>{national}</th>
              <th>IQR</th>
              <th>Premises</th>
              {selected.map((s) => (
                <th key={s.state}>
                  <i className="sw-line" style={{ background: s.color }} /> {s.state}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {periods.map((per) => {
              const n = get(national, per);
              return (
                <tr key={per}>
                  <td>{fmtPeriod(per, grain)}</td>
                  <td className="num strong">{n ? n.median.toFixed(2) : "–"}</td>
                  <td className="num muted">{n ? `${n.p25.toFixed(2)}–${n.p75.toFixed(2)}` : "–"}</td>
                  <td className="num muted">{n ? n.n_premises : "–"}</td>
                  {selected.map((s) => {
                    const r = get(s.state, per);
                    const thin = r && r.n_premises < MIN_PREMISES;
                    return (
                      <td
                        key={s.state}
                        className={`num${thin ? " thin" : ""}`}
                        title={r ? `${r.n_premises} premises` : undefined}
                      >
                        {r ? r.median.toFixed(2) : "–"}
                        {r && <span className="muted small"> ({r.n_premises})</span>}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="hint">
        Median price in RM; premises reporting in brackets. Faded cells have fewer than {MIN_PREMISES} premises.
      </p>
    </div>
  );
}
