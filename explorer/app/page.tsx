import { Explorer, type InitialView, type RangeKey, type Tab } from "@/components/Explorer";
import { loadItems } from "@/lib/data";
import { DEFAULT_STATES, FRESH_GROUP, MAX_COMPARE, STATES, type Grain } from "@/lib/shared";

export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function Page({ searchParams }: { searchParams: Promise<Search> }) {
  const meta = await loadItems();
  if (!meta) {
    return (
      <main className="empty">
        <h1>No summary table yet</h1>
        <p>
          From the repo root, run <code>npm run build:cube</code> (and <code>npm run download:pricecatcher</code> first
          if <code>datasets/pricecatcher/</code> is empty), then reload.
        </p>
      </main>
    );
  }

  const sp = await searchParams;
  // Default item: the fresh-produce item with the most observations.
  const fallback = meta.items
    .filter((i) => i.item_group === FRESH_GROUP)
    .reduce((a, b) => (b.n_obs > a.n_obs ? b : a), meta.items[0]);
  const wanted = Number(one(sp.item));
  const item = meta.items.some((i) => i.item_code === wanted) ? wanted : fallback.item_code;

  const statesParam = one(sp.states);
  const states =
    statesParam === undefined
      ? DEFAULT_STATES
      : statesParam
          .split(",")
          .filter((s): s is (typeof STATES)[number] => (STATES as readonly string[]).includes(s))
          .slice(0, MAX_COMPARE);

  const pick = <T extends string>(v: string | undefined, allowed: readonly T[], dflt: T): T =>
    allowed.includes(v as T) ? (v as T) : dflt;

  const initial: InitialView = {
    item,
    states,
    grain: pick<Grain>(one(sp.grain), ["week", "month"], "week"),
    tab: pick<Tab>(one(sp.tab), ["trend", "states", "table"], "trend"),
    range: pick<RangeKey>(one(sp.range), ["all", "pre", "post", "24m", "12m"], "all"),
  };

  return <Explorer meta={meta} initial={initial} />;
}
