"use client";
import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";

/** Colours for recharts (SVG attributes), mirroring the CSS variables in globals.css. */
export const CHART: Record<Theme, { grid: string; axis: string; tipBg: string; tipLine: string; green: string; red: string; blue: string; cursor: string }> = {
  dark: { grid: "#243049", axis: "#8b97b1", tipBg: "#121826", tipLine: "#243049", green: "#2ecc8f", red: "#ff5d6c", blue: "#5b8cff", cursor: "#ffffff10" },
  light: { grid: "#dde3ef", axis: "#5d6a85", tipBg: "#ffffff", tipLine: "#dde3ef", green: "#0f9f6a", red: "#d93a4b", blue: "#3b6df0", cursor: "#17203314" },
};

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>("dark");
  useEffect(() => {
    setThemeState(document.documentElement.dataset.theme === "light" ? "light" : "dark");
  }, []);
  const setTheme = useCallback((t: Theme) => {
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem("tj-theme", t); } catch {}
    setThemeState(t);
  }, []);
  return { theme, setTheme };
}
