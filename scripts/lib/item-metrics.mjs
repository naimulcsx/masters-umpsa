/**
 * Per-item "forecastability" metrics, computed from the cube's national and
 * per-state weekly/monthly series. Used by the explorer's Candidates page.
 *
 * All metrics use the national median series, counting a period only when at
 * least MIN_PREMISES premises reported (thinner periods are treated as missing).
 * Window: the first full week of 2022 (Mon 2022-01-03) to the end of the data.
 *
 *   coverage           share of weeks in the window with a usable national value
 *   state_density      per state: share of weeks with >= MIN_PREMISES premises
 *   change_rate        share of consecutive weeks in which the national median changed
 *   weekly_vol         std. dev. of weekly log changes (≈ typical % move per week)
 *   cv                 coefficient of variation of the weekly national median
 *   seasonal_strength  Hyndman's F_S = max(0, 1 − Var(R)/Var(S+R)) on monthly log
 *                      prices, using a classical 2×12 moving-average decomposition
 *   spectral_entropy   normalised Shannon entropy of the (Daniell-smoothed)
 *                      periodogram of weekly log changes, after Goerg (2013);
 *                      1 = white noise, lower = more regular structure to exploit
 *   break_shift        Jul–Sep 2025 vs Apr–Jun 2025 level change, net of the same
 *                      seasonal move a year earlier (Jul–Sep vs Apr–Jun 2024)
 *   break_premises     ratio of national premise counts, Jul–Sep vs Apr–Jun 2025
 */

import { rename, writeFile } from "node:fs/promises";

export const METRICS_START = "2022-01-03";
export const MIN_PREMISES = 3;

const BREAK_WINDOWS = {
  pre: ["2025-04-01", "2025-05-01", "2025-06-01"],
  post: ["2025-07-01", "2025-08-01", "2025-09-01"],
  pre0: ["2024-04-01", "2024-05-01", "2024-06-01"],
  post0: ["2024-07-01", "2024-08-01", "2024-09-01"],
};

const r4 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 1e4) / 1e4);
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
function variance(a) {
  if (a.length < 2) return null;
  const m = mean(a);
  return a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1);
}

/** Fill interior nulls by linear interpolation; leading/trailing nulls stay null. */
function fillInterior(arr) {
  const out = arr.slice();
  let last = -1;
  for (let i = 0; i < out.length; i++) {
    if (out[i] == null) continue;
    if (last >= 0 && i - last > 1) {
      for (let j = last + 1; j < i; j++) out[j] = out[last] + ((out[i] - out[last]) * (j - last)) / (i - last);
    }
    last = i;
  }
  return out;
}

function spectralEntropy(x) {
  const n = x.length;
  if (n < 32) return null;
  const m = mean(x);
  const y = x.map((v) => v - m);
  const K = Math.floor(n / 2);
  const I = new Array(K);
  for (let k = 1; k <= K; k++) {
    let re = 0;
    let im = 0;
    const w = (2 * Math.PI * k) / n;
    for (let t = 0; t < n; t++) {
      re += y[t] * Math.cos(w * t);
      im -= y[t] * Math.sin(w * t);
    }
    I[k - 1] = re * re + im * im;
  }
  // Daniell kernel (span 5) to stabilise the raw periodogram.
  const S = I.map((_, i) => {
    let s = 0;
    let c = 0;
    for (let j = i - 2; j <= i + 2; j++) if (j >= 0 && j < K) (s += I[j]), c++;
    return s / c;
  });
  const total = S.reduce((a, b) => a + b, 0);
  if (!(total > 1e-18)) return null;
  let h = 0;
  for (const s of S) {
    const p = s / total;
    if (p > 0) h -= p * Math.log(p);
  }
  return h / Math.log(K);
}

/** monthlyLog: aligned to `months` (YYYY-MM-01), nulls allowed. */
function seasonalStrength(monthlyLog, months) {
  const x = fillInterior(monthlyLog);
  const d = [];
  const cal = [];
  for (let t = 6; t < x.length - 6; t++) {
    const win = x.slice(t - 6, t + 7);
    if (win.some((v) => v == null)) continue;
    const trend = (0.5 * win[0] + win.slice(1, 12).reduce((a, b) => a + b, 0) + 0.5 * win[12]) / 12;
    d.push(x[t] - trend);
    cal.push(Number(months[t].slice(5, 7)) - 1);
  }
  if (d.length < 36) return null;
  const byMonth = Array.from({ length: 12 }, () => []);
  d.forEach((v, i) => byMonth[cal[i]].push(v));
  if (byMonth.some((l) => l.length < 2)) return null;
  const raw = byMonth.map(mean);
  const centre = mean(raw);
  const S = raw.map((v) => v - centre);
  const R = d.map((v, i) => v - S[cal[i]]);
  const vd = variance(d);
  if (!vd) return null;
  return Math.max(0, 1 - variance(R) / vd);
}

export async function buildItemMetrics(con, { cubePath, outPath, national, states }) {
  const q = async (sql) => (await con.runAndReadAll(sql)).getRowObjectsJson();
  const cube = `read_parquet('${cubePath.replaceAll("'", "''")}')`;
  const nat = `'${national.replaceAll("'", "''")}'`;

  const weeks = (
    await q(`SELECT DISTINCT strftime(period, '%Y-%m-%d') AS p FROM ${cube}
             WHERE grain = 'week' AND period >= '${METRICS_START}' ORDER BY 1`)
  ).map((r) => r.p);
  const months = (
    await q(`SELECT DISTINCT strftime(period, '%Y-%m-%d') AS p FROM ${cube}
             WHERE grain = 'month' ORDER BY 1`)
  ).map((r) => r.p);
  const weekIdx = new Map(weeks.map((w, i) => [w, i]));
  const monthIdx = new Map(months.map((m, i) => [m, i]));

  const weekly = await q(`
    SELECT item_code, strftime(period, '%Y-%m-%d') AS p, median, n_premises
    FROM ${cube} WHERE grain = 'week' AND state = ${nat} AND period >= '${METRICS_START}'`);
  const monthly = await q(`
    SELECT item_code, strftime(period, '%Y-%m-%d') AS p, median, n_premises
    FROM ${cube} WHERE grain = 'month' AND state = ${nat}`);
  const density = await q(`
    SELECT item_code, state, (count(*) FILTER (WHERE n_premises >= ${MIN_PREMISES}))::INTEGER AS good
    FROM ${cube} WHERE grain = 'week' AND state <> ${nat} AND period >= '${METRICS_START}'
    GROUP BY 1, 2`);

  const items = new Map();
  const get = (code) => {
    let it = items.get(code);
    if (!it) {
      it = {
        w: new Array(weeks.length).fill(null),
        wPrem: new Array(weeks.length).fill(0),
        m: new Array(months.length).fill(null),
        mPrem: new Array(months.length).fill(0),
        dens: {},
      };
      items.set(code, it);
    }
    return it;
  };
  for (const r of weekly) {
    const it = get(r.item_code);
    const i = weekIdx.get(r.p);
    it.wPrem[i] = r.n_premises;
    if (r.n_premises >= MIN_PREMISES && r.median > 0) it.w[i] = r.median;
  }
  for (const r of monthly) {
    const it = get(r.item_code);
    const i = monthIdx.get(r.p);
    it.mPrem[i] = r.n_premises;
    if (r.n_premises >= MIN_PREMISES && r.median > 0) it.m[i] = r.median;
  }
  for (const r of density) get(r.item_code).dens[r.state] = r.good / weeks.length;

  const out = [];
  for (const [code, it] of items) {
    const present = it.w.filter((v) => v != null);
    const coverage = present.length / weeks.length;

    let changes = 0;
    let pairs = 0;
    const logDiffs = [];
    for (let i = 1; i < it.w.length; i++) {
      const a = it.w[i - 1];
      const b = it.w[i];
      if (a == null || b == null) continue;
      pairs++;
      if (Math.abs(b - a) > 1e-9) changes++;
      logDiffs.push(Math.log(b / a));
    }
    const sdDiff = variance(logDiffs);

    // Entropy needs a near-complete series: interpolate small gaps, then use log changes.
    let entropy = null;
    if (coverage >= 0.9) {
      const filled = fillInterior(it.w).filter((v) => v != null);
      const dl = [];
      for (let i = 1; i < filled.length; i++) dl.push(Math.log(filled[i] / filled[i - 1]));
      entropy = spectralEntropy(dl);
    }

    const mLog = it.m.map((v) => (v == null ? null : Math.log(v)));
    const seasonal = seasonalStrength(mLog, months);

    const winMean = (keys, arr) => {
      const v = keys.map((k) => arr[monthIdx.get(k)]);
      return v.some((x) => x == null || x === 0) ? null : mean(v);
    };
    const pre = winMean(BREAK_WINDOWS.pre, mLog);
    const post = winMean(BREAK_WINDOWS.post, mLog);
    const pre0 = winMean(BREAK_WINDOWS.pre0, mLog);
    const post0 = winMean(BREAK_WINDOWS.post0, mLog);
    const breakShift =
      pre != null && post != null && pre0 != null && post0 != null ? Math.exp(post - pre - (post0 - pre0)) - 1 : null;
    const premPre = winMean(BREAK_WINDOWS.pre, it.mPrem);
    const premPost = winMean(BREAK_WINDOWS.post, it.mPrem);

    const lastIdx = it.w.findLastIndex((v) => v != null);
    const firstIdx = it.w.findIndex((v) => v != null);
    const premPresent = it.wPrem.filter((v) => v > 0);

    out.push({
      item_code: code,
      first_period: firstIdx >= 0 ? weeks[firstIdx] : null,
      last_period: lastIdx >= 0 ? weeks[lastIdx] : null,
      coverage: r4(coverage),
      state_density: Object.fromEntries(states.map((s) => [s, r4(it.dens[s] ?? 0)])),
      change_rate: pairs ? r4(changes / pairs) : null,
      weekly_vol: sdDiff == null ? null : r4(Math.sqrt(sdDiff)),
      cv: present.length > 1 ? r4(Math.sqrt(variance(present)) / mean(present)) : null,
      seasonal_strength: r4(seasonal),
      spectral_entropy: r4(entropy),
      break_shift: r4(breakShift),
      break_premises: premPre && premPost ? r4(premPost / premPre) : null,
      avg_premises: premPresent.length ? Math.round(mean(premPresent)) : 0,
      spark: it.m.map((v) => (v == null ? null : Math.round(v * 100) / 100)),
    });
  }
  out.sort((a, b) => a.item_code - b.item_code);

  const tmp = `${outPath}.part`;
  await writeFile(
    tmp,
    JSON.stringify({
      minPremises: MIN_PREMISES,
      start: METRICS_START,
      weeks: weeks.length,
      lastWeek: weeks.at(-1),
      months,
      items: out,
    }),
  );
  await rename(tmp, outPath);
  return out.length;
}
