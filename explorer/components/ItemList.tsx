"use client";

import { useMemo, useState } from "react";
import { FRESH_GROUP, addMonths, fmtMonth, itemLabel, type Item } from "@/lib/shared";

interface Props {
  items: Item[];
  selected: number;
  onSelect: (code: number) => void;
  dataEndWeek: string;
}

type Scope = "fresh" | "all";

export function ItemList({ items, selected, onSelect, dataEndWeek }: Props) {
  const [scope, setScope] = useState<Scope>(() =>
    items.find((i) => i.item_code === selected)?.item_group === FRESH_GROUP || selected < 0 ? "fresh" : "all",
  );
  const [query, setQuery] = useState("");

  const freshCount = useMemo(() => items.filter((i) => i.item_group === FRESH_GROUP).length, [items]);
  const endedBefore = addMonths(dataEndWeek, -2);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out = new Map<string, Item[]>();
    for (const it of items) {
      if (scope === "fresh" && it.item_group !== FRESH_GROUP) continue;
      const label = itemLabel(it);
      if (
        q &&
        !label.toLowerCase().includes(q) &&
        !String(it.item_code).includes(q) &&
        !(it.item_category ?? "").toLowerCase().includes(q)
      )
        continue;
      const head = !it.item
        ? "Unlabelled codes"
        : scope === "all"
          ? `${it.item_group ?? "?"} · ${it.item_category ?? "?"}`
          : (it.item_category ?? "Other");
      const list = out.get(head) ?? [];
      list.push(it);
      out.set(head, list);
    }
    return [...out.entries()];
  }, [items, scope, query]);

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <div className="seg" role="tablist" aria-label="Item scope">
          <button role="tab" aria-selected={scope === "fresh"} onClick={() => setScope("fresh")}>
            Fresh produce <span className="muted">{freshCount}</span>
          </button>
          <button role="tab" aria-selected={scope === "all"} onClick={() => setScope("all")}>
            All items <span className="muted">{items.length}</span>
          </button>
        </div>
        <input
          className="search"
          type="search"
          placeholder="Search item, category or code…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search items"
        />
      </div>
      <div className="item-scroll">
        {groups.length === 0 && <p className="hint pad">No items match “{query}”.</p>}
        {groups.map(([head, list]) => (
          <section key={head}>
            <h3 className="group-head">{head}</h3>
            <ul>
              {list.map((it) => {
                const ended = it.last_period < endedBefore;
                return (
                  <li key={it.item_code}>
                    <button
                      className={`item${it.item_code === selected ? " active" : ""}`}
                      onClick={() => onSelect(it.item_code)}
                      aria-current={it.item_code === selected}
                    >
                      <span className="item-name">{itemLabel(it)}</span>
                      <span className="item-meta">
                        {it.unit ?? ""}
                        <span className="code">#{it.item_code}</span>
                        {ended && <span className="tag">ended {fmtMonth(it.last_period)}</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </aside>
  );
}
