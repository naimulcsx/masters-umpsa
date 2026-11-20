#!/usr/bin/env node
/**
 * Downloads the PriceCatcher dataset (Parquet and/or CSV) from data.gov.my
 * for every month from 2022-01 up to the current month, into datasets/pricecatcher/.
 *
 * Usage:
 *   node scripts/download-pricecatcher.mjs                  # download all months (2022-01 .. now)
 *   node scripts/download-pricecatcher.mjs 2026-08          # download a single month
 *   node scripts/download-pricecatcher.mjs 2024-01 2024-12  # download a range
 *
 * Options:
 *   --format <parquet|csv|both>   which file format(s) to download (default: parquet)
 *                                 e.g. --format csv, --format=both
 *
 * Requires Node 18+ (global fetch).
 */

import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, stat, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const BASE_URL = "https://storage.data.gov.my/pricecatcher";
const isTTY = process.stdout.isTTY;
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "datasets", "pricecatcher");
const FORMAT_CHOICES = { parquet: ["parquet"], csv: ["csv"], both: ["csv", "parquet"] };
const DEFAULT_FORMAT = "parquet";
const LOOKUPS = ["lookup_item", "lookup_premise"];
// Widest possible filename across all formats (months are fixed-width YYYY-MM), so bars line up.
const LABEL_WIDTH = Math.max(
  ...["pricecatcher_0000-00", ...LOOKUPS].flatMap((n) => FORMAT_CHOICES.both.map((f) => `${n}.${f}`.length)),
);
const USAGE =
  "Usage: node scripts/download-pricecatcher.mjs [from YYYY-MM] [to YYYY-MM] [--format parquet|csv|both]";
const START = "2022-01";
const CONCURRENCY = 4;
const TIMEOUT_MS = 120_000; // per-file download timeout

function currentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

/** Inclusive list of YYYY-MM strings from `from` to `to`. */
function monthRange(from, to) {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  const months = [];
  for (let y = fy, m = fm; y < ty || (y === ty && m <= tm); m === 12 ? (y++, (m = 1)) : m++) {
    months.push(`${y}-${String(m).padStart(2, "0")}`);
  }
  return months;
}

function isValidMonth(s) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

function fmtMB(bytes) {
  return (bytes / 1024 / 1024).toFixed(1);
}

function bar(received, total, width = 20) {
  if (!total) return `[${"░".repeat(width)}]      ${fmtMB(received)} MB`;
  const pct = Math.min(received / total, 1);
  const filled = Math.round(pct * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}] ${String(Math.floor(pct * 100)).padStart(3)}% ${fmtMB(received)}/${fmtMB(total)} MB`;
}

/**
 * Multi-line live progress display: one in-place bar per active download,
 * with completed/skipped/failed lines scrolling up above the bars.
 * Falls back to plain line-per-event output when stdout is not a TTY.
 */
class Progress {
  #active = new Map();
  #rendered = 0;
  #lastDraw = 0;

  #clear() {
    if (this.#rendered > 0) process.stdout.write(`\x1b[${this.#rendered}A\x1b[0J`);
    this.#rendered = 0;
  }

  #draw() {
    this.#clear();
    let out = "";
    for (const { label, received, total } of this.#active.values()) {
      out += `  get     ${label} ${bar(received, total)}\n`;
    }
    process.stdout.write(out);
    this.#rendered = this.#active.size;
    this.#lastDraw = Date.now();
  }

  start(id, label) {
    if (!isTTY) return console.log(`  get     ${label} ...`);
    this.#active.set(id, { label, received: 0, total: 0 });
    this.#draw();
  }

  update(id, received, total) {
    if (!isTTY) return;
    const entry = this.#active.get(id);
    if (!entry) return;
    entry.received = received;
    entry.total = total;
    if (Date.now() - this.#lastDraw >= 80) this.#draw();
  }

  /** Print a permanent line above the active bars (also used for skip/missing/fail). */
  log(line, stream = console.log) {
    if (!isTTY) return stream(line);
    this.#clear();
    stream(line);
    this.#draw();
  }

  finish(id, line, stream) {
    this.#active.delete(id);
    this.log(line, stream);
  }
}

const progress = new Progress();

if (isTTY) {
  process.stdout.write("\x1b[?25l"); // hide cursor while bars redraw
  const showCursor = () => process.stdout.write("\x1b[?25h");
  process.on("exit", showCursor);
  process.on("SIGINT", () => {
    showCursor();
    process.exit(130);
  });
}

async function download(filename) {
  const label = filename.padEnd(LABEL_WIDTH);
  const dest = join(OUT_DIR, filename);

  if (existsSync(dest)) {
    progress.log(`  skip    ${label} (already exists)`);
    return "skipped";
  }

  const url = `${BASE_URL}/${filename}`;
  progress.start(filename, label);
  const tmp = `${dest}.part`;
  try {
    // The timeout covers the whole download (headers + body): aborting the
    // signal also aborts the body stream mid-pipeline.
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const res = await fetch(url, { signal });
    if (res.status === 404 || res.status === 403) {
      progress.finish(filename, `  missing ${label} (HTTP ${res.status})`, console.warn);
      return "missing";
    }
    if (!res.ok) {
      progress.finish(filename, `  fail    ${label} (HTTP ${res.status})`, console.error);
      return "failed";
    }
    const total = Number(res.headers.get("content-length")) || 0;
    let received = 0;
    // Stream to a temp path first so an interrupted download never leaves a
    // partial file that would be skipped on the next run.
    await pipeline(
      Readable.fromWeb(res.body, { signal }),
      async function* (source) {
        for await (const chunk of source) {
          received += chunk.length;
          progress.update(filename, received, total);
          yield chunk;
        }
      },
      createWriteStream(tmp),
    );
    await rename(tmp, dest);
    const { size } = await stat(dest);
    progress.finish(filename, `  done    ${label} ${bar(size, size)}`);
    return "ok";
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
      progress.finish(filename, `  fail    ${label}: timed out after ${TIMEOUT_MS / 1000}s`, console.error);
    } else {
      progress.finish(filename, `  fail    ${label}: ${err?.message ?? err}`, console.error);
    }
    return "failed";
  }
}

/** Splits argv into positional month args and the --format value. Exits on bad input. */
function parseArgs(argv) {
  const positional = [];
  let format = DEFAULT_FORMAT;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      console.log(USAGE);
      process.exit(0);
    } else if (arg === "--format") {
      format = argv[++i];
    } else if (arg.startsWith("--format=")) {
      format = arg.slice("--format=".length);
    } else if (arg.startsWith("-")) {
      console.error(`Unknown option: ${arg}\n${USAGE}`);
      process.exit(1);
    } else {
      positional.push(arg);
    }
  }
  if (!Object.hasOwn(FORMAT_CHOICES, format ?? "")) {
    console.error(`Invalid --format: ${format ?? "(missing)"} (expected parquet, csv or both)\n${USAGE}`);
    process.exit(1);
  }
  if (positional.length > 2) {
    console.error(USAGE);
    process.exit(1);
  }
  return { positional, format };
}

async function main() {
  const { positional, format } = parseArgs(process.argv.slice(2));
  const formats = FORMAT_CHOICES[format];
  const from = positional[0] ?? START;
  const to = positional[1] ?? positional[0] ?? currentMonth();

  if (!isValidMonth(from) || !isValidMonth(to)) {
    console.error(USAGE);
    process.exit(1);
  }

  await mkdir(OUT_DIR, { recursive: true });

  const months = monthRange(from, to);
  const monthly = months.flatMap((month) => formats.map((f) => `pricecatcher_${month}.${f}`));
  const lookups = LOOKUPS.flatMap((name) => formats.map((f) => `${name}.${f}`));
  console.log(
    `Downloading ${months.length} month(s) (${from} → ${to}) as ${formats.join(" + ")} + ${lookups.length} lookup files, ${monthly.length + lookups.length} files total, into ${OUT_DIR}\n`,
  );

  const counts = { ok: 0, skipped: 0, missing: 0, failed: 0 };

  // Simple worker pool
  async function runPool(filenames) {
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, filenames.length) }, async () => {
        while (next < filenames.length) {
          counts[await download(filenames[next++])]++;
        }
      }),
    );
  }

  await runPool(monthly);
  await runPool(lookups);

  console.log(`\nDone: ${counts.ok} downloaded, ${counts.skipped} skipped, ${counts.missing} missing, ${counts.failed} failed`);
  if (counts.failed > 0) process.exit(1);
}

await main();
