"use client";
import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";

/** Colours for recharts (SVG attributes), mirroring the CSS variables in globals.css. */
export const CHART: Record<Theme, { grid: string; axis: string; tipBg: string; tipLine: string; green: string; red: string; blue: string; cursor: string }> = {
  dark: { grid: "#232836", axis: "#7f8aa0", tipBg: "#1a1e28", tipLine: "#232836", green: "#34d399", red: "#fb7185", blue: "#7c85ff", cursor: "#ffffff0d" },
  light: { grid: "#e1e4ef", axis: "#667089", tipBg: "#ffffff", tipLine: "#e1e4ef", green: "#059669", red: "#e11d48", blue: "#4f5bf5", cursor: "#12151f0d" },
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
