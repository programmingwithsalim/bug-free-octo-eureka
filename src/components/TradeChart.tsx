"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { CandlestickSeries, ColorType, CrosshairMode, LineStyle, createChart, createSeriesMarkers, type SeriesMarker, type UTCTimestamp } from "lightweight-charts";
import { LineChart } from "lucide-react";
import type { Trade } from "@/lib/types";
import type { Analysis } from "@/lib/analysis";
import { TFS, chartWindow, chooseTf, localOffsetSec, snapToCandle, type CandleRow, type TF } from "@/lib/chart";
import { money } from "@/lib/format";
import Seg from "./Seg";

const css = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const palette = () => ({
  text: css("--muted"), grid: css("--line"), up: css("--green"), down: css("--red"), accent: css("--accent"), bg: css("--panel"),
});

/** Candlestick chart of one trade from MT5 history: entry/exit markers, entry/exit/SL/TP lines. */
export default function TradeChart({ trade, currency, analysis, showPlan = false }: { trade: Trade; currency: string; analysis?: Analysis | null; showPlan?: boolean }) {
  const open = +new Date(trade.openTime), close = +new Date(trade.closeTime);
  const win = useMemo(() => chartWindow(open, close), [open, close]);
  const [tf, setTf] = useState<TF>(() => chooseTf(win.from, win.to));
  const [candles, setCandles] = useState<CandleRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    setCandles(null); setErr(null);
    fetch(`/api/candles?symbol=${encodeURIComponent(trade.symbol)}&tf=${tf}&from=${win.from}&to=${win.to}`)
      .then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error ?? "Request failed"); return d.candles as CandleRow[]; })
      .then((c) => live && setCandles(c))
      .catch((e: Error) => live && setErr(e.message));
    return () => { live = false; };
  }, [trade.symbol, tf, win.from, win.to]);

  useEffect(() => {
    if (!candles || !box.current) return;
    const p = palette();
    const chart = createChart(box.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: p.text, fontFamily: "inherit", attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: p.grid, style: LineStyle.Dotted } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      crosshair: { mode: CrosshairMode.Normal },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: p.up, downColor: p.down, borderVisible: false, wickUpColor: p.up, wickDownColor: p.down,
      priceLineVisible: false, lastValueVisible: false, // the "last price" line is meaningless for a closed trade
    });
    const off = localOffsetSec(open); // show local time on the axis
    series.setData(candles.map(([t, o, h, l, c]) => ({ time: (t + off) as UTCTimestamp, open: o, high: h, low: l, close: c })));

    const long = trade.side === "long", win_ = trade.pnl >= 0;
    const at = (ms: number) => (snapToCandle(ms / 1000, tf) + off) as UTCTimestamp;
    const markers: SeriesMarker<UTCTimestamp>[] = [
      { time: at(open), position: long ? "belowBar" : "aboveBar", shape: long ? "arrowUp" : "arrowDown", color: p.accent, text: `${long ? "Buy" : "Sell"} ${trade.size}` },
      { time: at(close), position: long ? "aboveBar" : "belowBar", shape: long ? "arrowDown" : "arrowUp", color: win_ ? p.up : p.down, text: `Exit ${money(trade.pnl, currency)}` },
    ];
    if (analysis?.ok) { // measured extremes while the trade was open
      const { mfePoint, maePoint } = analysis;
      if (mfePoint && analysis.mfe > 0) markers.push({ time: at(mfePoint.time * 1000), position: long ? "aboveBar" : "belowBar", shape: "circle", color: p.up, text: "Best point" });
      if (maePoint && analysis.mae > 0) markers.push({ time: at(maePoint.time * 1000), position: long ? "belowBar" : "aboveBar", shape: "circle", color: p.down, text: "Worst point" });
    }
    createSeriesMarkers(series, markers.sort((a, b) => (a.time as number) - (b.time as number)));

    const line = (price: number | undefined, color: string, title: string, style = LineStyle.Dashed) =>
      price ? series.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title }) : null;
    line(trade.entry, p.accent, "Entry");
    line(trade.exit, win_ ? p.up : p.down, "Exit", LineStyle.Dotted);
    line(trade.stopLoss, p.down, "SL");
    line(trade.takeProfit, p.up, "TP");
    if (showPlan && analysis?.suggestion) { // ATR-based reference plan (what a 1-3 ATR stop and 2R target would have looked like)
      line(analysis.suggestion.stop, p.accent, "Plan SL", LineStyle.SparseDotted);
      line(analysis.suggestion.target, p.accent, "Plan TP 2R", LineStyle.SparseDotted);
    }
    chart.timeScale().fitContent();

    // follow light/dark switches
    const mo = new MutationObserver(() => {
      const n = palette();
      chart.applyOptions({ layout: { textColor: n.text }, grid: { horzLines: { color: n.grid } } });
      series.applyOptions({ upColor: n.up, downColor: n.down, wickUpColor: n.up, wickDownColor: n.down });
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => { mo.disconnect(); chart.remove(); };
  }, [candles, trade, tf, open, close, currency, analysis, showPlan]);

  return (
    <div className="trade-chart">
      <div className="tc-head">
        <span className="muted"><LineChart size={14} style={{ verticalAlign: -2 }} /> {trade.symbol} · {tf}{candles ? ` · ${candles.length} candles` : ""}</span>
        <Seg label="Timeframe" value={tf} onChange={setTf} options={TFS.filter((t) => t !== "H4").map((t) => ({ id: t, label: t }))} />
      </div>
      {err ? <div className="note neg">Chart unavailable: {err}</div>
        : !candles ? <div className="skel" style={{ height: 320 }} />
        : <div ref={box} className="tc-box fade-in" />}
    </div>
  );
}
