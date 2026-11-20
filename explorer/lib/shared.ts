// Types, constants and formatting shared by the server routes and the client UI.

export type Grain = "week" | "month";

export interface Item {
  item_code: number;
  item: string | null;
  unit: string | null;
  item_group: string | null;
  item_category: string | null;
  first_period: string;
  last_period: string;
  n_obs: number;
}

export interface ItemsFile {
  builtAt: string;
  dataEnd: string; // last raw observation date, YYYY-MM-DD
  dataEndWeek: string; // Monday of the last week in the cube
  national: string; // name of the national pseudo-state ("Malaysia")
  items: Item[];
}

export interface SeriesRow {
  state: string;
  period: string; // YYYY-MM-DD (Monday for weeks, 1st for months)
  median: number;
  p25: number;
  p75: number;
  n_premises: number;
  n_obs: number;
}

export interface SeriesResponse {
  item_code: number;
  week: SeriesRow[];
  month: SeriesRow[];
}

export const STATES = [
  "Johor",
  "Kedah",
  "Kelantan",
  "Melaka",
  "Negeri Sembilan",
  "Pahang",
  "Perak",
  "Perlis",
  "Pulau Pinang",
  "Sabah",
  "Sarawak",
  "Selangor",
  "Terengganu",
  "W.P. Kuala Lumpur",
  "W.P. Labuan",
  "W.P. Putrajaya",
] as const;

/** States with few reporting premises — medians there are noisy. */
export const SPARSE_STATES = new Set<string>(["Perlis", "W.P. Labuan", "W.P. Putrajaya"]);

export const DEFAULT_STATES = ["Selangor", "W.P. Kuala Lumpur", "Sabah", "Sarawak"];
export const FRESH_GROUP = "BARANGAN SEGAR";
/** July 2025: basket cut (516 → 347 items) and premise panel expanded. */
export const BREAK_PERIOD = "2025-07-01";
/** Points backed by fewer premises than this are treated as too thin to plot. */
export const MIN_PREMISES = 3;
/** Categorical palette has 8 validated slots — never more coloured series than that. */
export const MAX_COMPARE = 8;

export function itemLabel(it: Pick<Item, "item" | "item_code">): string {
  return it.item ?? `Item ${it.item_code} (unlabelled)`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function fmtMonth(period: string): string {
  const [y, m] = period.split("-");
  return `${MONTHS[Number(m) - 1]} ${y}`;
}

export function fmtPeriod(period: string, grain: Grain): string {
  if (grain === "month") return fmtMonth(period);
  const [y, m, d] = period.split("-");
  return `Week of ${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

export function fmtRM(v: number | null | undefined): string {
  return v == null || Number.isNaN(v) ? "–" : `RM ${v.toFixed(2)}`;
}

export function fmtPct(v: number): string {
  const s = (v * 100).toFixed(1);
  return v > 0 ? `+${s}%` : `${s}%`;
}

export function fmtCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  return n.toLocaleString("en-US");
}

/** Shift a YYYY-MM-DD date by whole months, returning the 1st of that month. */
export function addMonths(period: string, months: number): string {
  const [y, m] = period.split("-").map(Number);
  const total = y * 12 + (m - 1) + months;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}-01`;
}
