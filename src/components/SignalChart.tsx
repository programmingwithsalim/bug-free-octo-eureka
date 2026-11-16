"use client";
import { useEffect, useRef, useState } from "react";
import { CandlestickSeries, ColorType, LineStyle, createChart, createSeriesMarkers, type SeriesMarker, type UTCTimestamp } from "lightweight-charts";
import type { SignalRec } from "@/lib/alerts";
import { localOffsetSec, type CandleRow } from "@/lib/chart";

const css = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

/** M15 candles around an alert with entry / stop / target / key level lines and the pattern's pivot points. */
export default function SignalChart({ sig }: { sig: SignalRec }) {
  const [candles, setCandles] = useState<CandleRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const from = sig.time - 10 * 3600, to = Math.min(Math.floor(Date.now() / 1000), sig.close_time + 12 * 3600);

  useEffect(() => {
    let live = true;
    fetch(`/api/candles?symbol=${encodeURIComponent(sig.symbol)}&tf=M15&from=${from}&to=${to}`)
      .then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error ?? "Request failed"); return d.candles as CandleRow[]; })
      .then((c) => live && setCandles(c)).catch((e: Error) => live && setErr(e.message));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig.id]);

  useEffect(() => {
    if (!candles || !box.current) return;
    const up = css("--green"), down = css("--red"), accent = css("--accent"), muted = css("--muted");
    const chart = createChart(box.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: muted, fontFamily: "inherit", attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: css("--line"), style: LineStyle.Dotted } },
      rightPriceScale: { borderVisible: false }, timeScale: { borderVisible: false, timeVisible: true },
    });
    const series = chart.addSeries(CandlestickSeries, { upColor: up, downColor: down, borderVisible: false, wickUpColor: up, wickDownColor: down, priceLineVisible: false, lastValueVisible: false });
    const off = localOffsetSec(sig.time * 1000);
    series.setData(candles.map(([t, o, h, l, c]) => ({ time: (t + off) as UTCTimestamp, open: o, high: h, low: l, close: c })));
    const at = (t: number) => (Math.floor(t / 900) * 900 + off) as UTCTimestamp;
    const buy = sig.side === "buy";
    const markers: SeriesMarker<UTCTimestamp>[] = [
      { time: at(sig.time), position: (buy ? "belowBar" : "aboveBar") as "belowBar" | "aboveBar", shape: (buy ? "arrowUp" : "arrowDown") as "arrowUp" | "arrowDown", color: accent, text: `${buy ? "Buy" : "Sell"} signal` },
      ...sig.points.map((p) => ({ time: at(p.t), position: (p.price >= sig.entry ? "aboveBar" : "belowBar") as "aboveBar" | "belowBar", shape: "circle" as const, color: muted, text: p.label })),
    ].sort((a, b) => (a.time as number) - (b.time as number));
    createSeriesMarkers(series, markers);
    const line = (price: number | undefined, color: string, title: string, style = LineStyle.Dashed) => price ? series.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title }) : null;
    line(sig.entry, accent, "Entry"); line(sig.sl, down, "SL"); line(sig.tp, up, "TP");
    line(sig.level, muted, sig.level_label ?? "Level", LineStyle.Dotted);
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [candles, sig]);

  if (err) return <div className="note neg">Chart unavailable: {err}</div>;
  if (!candles) return <div className="skel" style={{ height: 300 }} />;
  return <div ref={box} className="tc-box fade-in" style={{ height: 300 }} />;
}
