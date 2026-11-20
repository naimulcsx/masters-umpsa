#!/usr/bin/env node
/**
 * Builds the pre-aggregated "cube" the explorer app reads, from the raw
 * PriceCatcher Parquet files in datasets/pricecatcher/.
 *
 * Output (datasets/derived/):
 *   cube.parquet  one row per (grain, item_code, state, period)
 *                 grain    'week' (Monday-anchored) | 'month'
 *                 state    one of the 16 states, or 'Malaysia' for the national row
 *                 median, p25, p75   across premises, of each premise's mean price in the period
 *                 n_premises         premises that reported the item in the period
 *                 n_obs              raw price observations behind the row
 *   items.json    item metadata (name, unit, group, category, coverage) + build info
 *   metrics.json  per-item forecastability metrics (see scripts/lib/item-metrics.mjs)
 *
 * Aggregation is two-step: each premise is first collapsed to one mean price
 * per period, then the median is taken across premises, so a shop that
 * reports daily does not outweigh one that reports weekly.
 *
 * Usage:
 *   node scripts/build-cube.mjs              # rebuild
 *   node scripts/build-cube.mjs --if-stale   # rebuild only if raw data is newer than the outputs
 *   node scripts/build-cube.mjs --metrics-only  # recompute metrics.json from the existing cube
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DuckDBInstance } from "@duckdb/node-api";
import { buildItemMetrics } from "./lib/item-metrics.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RAW_DIR = join(ROOT, "datasets", "pricecatcher");
const OUT_DIR = join(ROOT, "datasets", "derived");
const CUBE = join(OUT_DIR, "cube.parquet");
const ITEMS = join(OUT_DIR, "items.json");
const METRICS = join(OUT_DIR, "metrics.json");
const NATIONAL = "Malaysia";
const STATES = [
  "Johor", "Kedah", "Kelantan", "Melaka", "Negeri Sembilan", "Pahang", "Perak", "Perlis",
  "Pulau Pinang", "Sabah", "Sarawak", "Selangor", "Terengganu",
  "W.P. Kuala Lumpur", "W.P. Labuan", "W.P. Putrajaya",
];

/** SQL string literal (paths are ours, but quote defensively). */
const lit = (s) => `'${s.replaceAll("'", "''")}'`;

function rawFiles() {
  if (!existsSync(RAW_DIR)) return [];
  return readdirSync(RAW_DIR)
    .filter((f) => f.endsWith(".parquet"))
    .map((f) => join(RAW_DIR, f));
}

function isStale() {
  const outputs = [CUBE, ITEMS, METRICS];
  if (outputs.some((f) => !existsSync(f))) return true;
  const built = Math.min(...outputs.map((f) => statSync(f).mtimeMs));
  // Metrics code changing also invalidates metrics.json.
  const inputs = [...rawFiles(), join(ROOT, "scripts", "lib", "item-metrics.mjs")];
  return inputs.some((f) => statSync(f).mtimeMs > built);
}

async function main() {
  const ifStale = process.argv.includes("--if-stale");
  const metricsOnly = process.argv.includes("--metrics-only");
  const monthly = rawFiles().filter((f) => /pricecatcher_\d{4}-\d{2}\.parquet$/.test(f));
  const lookupItem = join(RAW_DIR, "lookup_item.parquet");
  const lookupPremise = join(RAW_DIR, "lookup_premise.parquet");

  if (monthly.length === 0 || !existsSync(lookupItem) || !existsSync(lookupPremise)) {
    console.error(
      `No Parquet data found in ${RAW_DIR}.\nRun: npm run download:pricecatcher`,
    );
    process.exit(1);
  }

  if (ifStale && !isStale()) {
    console.log("Cube is up to date — skipping rebuild.");
    return;
  }

  await mkdir(OUT_DIR, { recursive: true });
  const started = Date.now();
  const db = await DuckDBInstance.create(":memory:");
  const con = await db.connect();

  // Only the metrics are missing/outdated and the cube exists: skip the slow part.
  const cubeFresh =
    existsSync(CUBE) && existsSync(ITEMS) &&
    !rawFiles().some((f) => statSync(f).mtimeMs > Math.min(statSync(CUBE).mtimeMs, statSync(ITEMS).mtimeMs));
  if (metricsOnly || (ifStale && cubeFresh)) {
    if (!existsSync(CUBE)) {
      console.error("No cube yet — run without --metrics-only first.");
      process.exit(1);
    }
    await writeMetrics(con, started);
    con.closeSync();
    return;
  }

  console.log(`Building cube from ${monthly.length} monthly files…`);

  const tmpCube = `${CUBE}.part`;
  await con.run(`
    COPY (
      WITH raw AS (
        SELECT p.item_code, l.state, p.premise_code, p.date, p.price
        FROM read_parquet(${lit(join(RAW_DIR, "pricecatcher_*.parquet"))}) p
        JOIN read_parquet(${lit(lookupPremise)}) l USING (premise_code)
        WHERE l.state IS NOT NULL AND p.price > 0 AND p.item_code IS NOT NULL
      ),
      per_premise AS (
        SELECT 'week' AS grain, item_code, state, premise_code,
               date_trunc('week', date)::DATE AS period, avg(price) AS price, count(*) AS n
        FROM raw GROUP BY ALL
        UNION ALL
        SELECT 'month', item_code, state, premise_code,
               date_trunc('month', date)::DATE, avg(price), count(*)
        FROM raw GROUP BY ALL
      )
      SELECT grain, item_code,
             CASE WHEN grouping(state) = 1 THEN ${lit(NATIONAL)} ELSE state END AS state,
             period,
             median(price)              AS median,
             quantile_cont(price, 0.25) AS p25,
             quantile_cont(price, 0.75) AS p75,
             count(*)::INTEGER          AS n_premises,
             sum(n)::INTEGER            AS n_obs
      FROM per_premise
      GROUP BY GROUPING SETS ((grain, item_code, state, period), (grain, item_code, period))
      ORDER BY item_code, grain, state, period
    ) TO ${lit(tmpCube)} (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 100000)
  `);
  await rename(tmpCube, CUBE);

  const items = (
    await con.runAndReadAll(`
      SELECT c.item_code,
             l.item, l.unit, l.item_group, l.item_category,
             strftime(min(c.period), '%Y-%m-%d') AS first_period,
             strftime(max(c.period), '%Y-%m-%d') AS last_period,
             sum(c.n_obs)::BIGINT::DOUBLE         AS n_obs
      FROM read_parquet(${lit(CUBE)}) c
      LEFT JOIN read_parquet(${lit(lookupItem)}) l USING (item_code)
      WHERE c.grain = 'week' AND c.state = ${lit(NATIONAL)}
      GROUP BY ALL
      ORDER BY l.item_group NULLS LAST, l.item_category NULLS LAST, l.item NULLS LAST, c.item_code
    `)
  ).getRowObjectsJson();

  const meta = (
    await con.runAndReadAll(`
      SELECT strftime(max(period), '%Y-%m-%d') AS data_end_week,
             count(*)::DOUBLE AS cube_rows
      FROM read_parquet(${lit(CUBE)}) WHERE grain = 'week'
    `)
  ).getRowObjectsJson()[0];
  const lastDay = (
    await con.runAndReadAll(`
      SELECT strftime(max(date), '%Y-%m-%d') AS d
      FROM read_parquet(${lit(join(RAW_DIR, "pricecatcher_*.parquet"))})
    `)
  ).getRowObjectsJson()[0].d;

  const tmpItems = `${ITEMS}.part`;
  await writeFile(
    tmpItems,
    JSON.stringify(
      {
        builtAt: new Date().toISOString(),
        dataEnd: lastDay,
        dataEndWeek: meta.data_end_week,
        national: NATIONAL,
        items,
      },
      null,
      1,
    ),
  );
  await rename(tmpItems, ITEMS);

  const mb = (statSync(CUBE).size / 1024 / 1024).toFixed(1);
  console.log(
    `Cube built in ${((Date.now() - started) / 1000).toFixed(1)}s: ${CUBE} (${mb} MB), ${items.length} items, data through ${lastDay}`,
  );
  await writeMetrics(con, Date.now());
  con.closeSync();
}

async function writeMetrics(con, started) {
  const n = await buildItemMetrics(con, { cubePath: CUBE, outPath: METRICS, national: NATIONAL, states: STATES });
  console.log(`Metrics for ${n} items in ${((Date.now() - started) / 1000).toFixed(1)}s: ${METRICS}`);
}

main().catch(async (err) => {
  await rm(`${CUBE}.part`, { force: true }).catch(() => {});
  console.error(err);
  process.exit(1);
});
