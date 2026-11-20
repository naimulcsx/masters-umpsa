"use client";

import { useSyncExternalStore } from "react";

// Chart palette — the dataviz reference palette, validated with
// validate_palette.js in both modes (all checks pass; light slots 3–5 sit
// below 3:1 on the surface, so lines carry direct end labels and every chart
// has a table view).
export interface ChartTheme {
  mode: "light" | "dark";
  surface: string;
  ink: string;
  ink2: string;
  muted: string;
  grid: string;
  axis: string;
  context: string; // unselected states drawn as grey context lines
  band: string; // national p25–p75 spread band
  series: string[]; // categorical slots 1–8, fixed order
  diverging: string[]; // cheaper (blue) → neutral grey → pricier (red)
}

export const THEMES: Record<"light" | "dark", ChartTheme> = {
  light: {
    mode: "light",
    surface: "#fcfcfb",
    ink: "#0b0b0b",
    ink2: "#52514e",
    muted: "#898781",
    grid: "#e1e0d9",
    axis: "#c3c2b7",
    context: "#dad9d2",
    band: "rgba(11,11,11,0.07)",
    series: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"],
    diverging: ["#184f95", "#6da7ec", "#f0efec", "#ef9a99", "#b8302f"],
  },
  dark: {
    mode: "dark",
    surface: "#1a1a19",
    ink: "#f0efec",
    ink2: "#c3c2b7",
    muted: "#898781",
    grid: "#2c2c2a",
    axis: "#383835",
    context: "#3a3a37",
    band: "rgba(240,239,236,0.09)",
    series: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
    diverging: ["#6da7ec", "#2f5f9e", "#383835", "#a43a39", "#ef7f7e"],
  },
};

const query = "(prefers-color-scheme: dark)";

function subscribe(cb: () => void) {
  const mql = window.matchMedia(query);
  mql.addEventListener("change", cb);
  return () => mql.removeEventListener("change", cb);
}

/** Follows the OS light/dark setting. */
export function useChartTheme(): ChartTheme {
  const dark = useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
  return THEMES[dark ? "dark" : "light"];
}
