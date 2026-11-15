"use client";
import type { ReactNode } from "react";

/** Segmented control with a pill that slides to the selected option. */
export default function Seg<T extends string>({ options, value, onChange, label }: {
  options: { id: T; label: ReactNode }[]; value: T; onChange: (v: T) => void; label: string;
}) {
  const i = Math.max(0, options.findIndex((o) => o.id === value));
  return (
    <div className="seg" role="group" aria-label={label} style={{ "--n": options.length, "--i": i } as React.CSSProperties}>
      <span className="seg-pill" />
      {options.map((o) => (
        <button key={o.id} className={o.id === value ? "on" : ""} onClick={() => onChange(o.id)}>{o.label}</button>
      ))}
    </div>
  );
}
