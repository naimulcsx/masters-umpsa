// Server-only data access: the pre-built cube (datasets/derived/) via DuckDB.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import type { MetricsFile } from "./candidates";
import type { ItemsFile, SeriesResponse, SeriesRow } from "./shared";

export const DERIVED_DIR =
  process.env.PRICECATCHER_DERIVED ?? path.resolve(process.cwd(), "..", "datasets", "derived");
const CUBE = path.join(DERIVED_DIR, "cube.parquet");
const ITEMS = path.join(DERIVED_DIR, "items.json");
const METRICS = path.join(DERIVED_DIR, "metrics.json");

// One DuckDB connection per server process; kept on globalThis so dev-mode
// hot reloads don't open a new database on every edit.
const g = globalThis as typeof globalThis & { __pricecatcherCon?: Promise<DuckDBConnection> };

function connection(): Promise<DuckDBConnection> {
  g.__pricecatcherCon ??= (async () => {
    const db = await DuckDBInstance.create(":memory:");
    const con = await db.connect();
    // A view re-reads the file on every query, so a rebuilt cube is picked up
    // without restarting. The file is sorted by item_code, so Parquet row-group
    // stats let DuckDB read only the slice for one item.
    await con.run(`CREATE VIEW cube AS SELECT * FROM read_parquet('${CUBE.replaceAll("'", "''")}')`);
    return con;
  })().catch((err) => {
    g.__pricecatcherCon = undefined;
    throw err;
  });
  return g.__pricecatcherCon;
}

export async function loadItems(): Promise<ItemsFile | null> {
  try {
    return JSON.parse(await readFile(ITEMS, "utf8")) as ItemsFile;
  } catch {
    return null;
  }
}

export async function loadMetrics(): Promise<MetricsFile | null> {
  try {
    return JSON.parse(await readFile(METRICS, "utf8")) as MetricsFile;
  } catch {
    return null;
  }
}

export async function loadSeries(itemCode: number): Promise<SeriesResponse> {
  const con = await connection();
  const reader = await con.runAndReadAll(
    `SELECT grain, state, strftime(period, '%Y-%m-%d') AS period,
            median, p25, p75, n_premises, n_obs
     FROM cube WHERE item_code = $1
     ORDER BY grain, state, period`,
    [itemCode],
  );
  const out: SeriesResponse = { item_code: itemCode, week: [], month: [] };
  for (const r of reader.getRowObjectsJson()) {
    const row: SeriesRow = {
      state: r.state as string,
      period: r.period as string,
      median: r.median as number,
      p25: r.p25 as number,
      p75: r.p75 as number,
      n_premises: r.n_premises as number,
      n_obs: r.n_obs as number,
    };
    (r.grain === "week" ? out.week : out.month).push(row);
  }
  return out;
}
