"use client";

import { useId, useState } from "react";

export interface TrendChartPoint {
  /** First day of the month, YYYY-MM-DD. */
  date: string;
  /** Relative interest, 0–100. */
  value: number;
}

const WIDTH = 640;
const HEIGHT = 180;
const MARGIN = { top: 12, right: 40, bottom: 24, left: 32 };
const PLOT_WIDTH = WIDTH - MARGIN.left - MARGIN.right;
const PLOT_HEIGHT = HEIGHT - MARGIN.top - MARGIN.bottom;
const Y_TICKS = [0, 50, 100];

function monthLabel(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

/**
 * Five years of monthly Google Trends interest as a single line. The scale is
 * fixed at 0–100 because the values are an index, not a count. Hovering or
 * arrowing through the chart reads out each month; the same numbers are in the
 * table under "Show data".
 */
export function TrendChart({ points, label }: { points: TrendChartPoint[]; label: string }) {
  const [active, setActive] = useState<number | null>(null);
  const titleId = useId();
  if (points.length < 2) return <p className="text-sm text-muted-foreground">Not enough data to draw a trend.</p>;

  const x = (index: number) => MARGIN.left + (index / (points.length - 1)) * PLOT_WIDTH;
  const y = (value: number) => MARGIN.top + (1 - Math.min(100, Math.max(0, value)) / 100) * PLOT_HEIGHT;
  const line = points.map((point, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(point.value).toFixed(1)}`).join(" ");
  const area = `${line} L${x(points.length - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z`;
  const last = points.length - 1;
  // One tick per January keeps the axis to five or six labels.
  const yearTicks = points.flatMap((point, index) => (point.date.slice(5, 7) === "01" ? [{ index, year: point.date.slice(0, 4) }] : []));
  const shown = active === null ? null : points[active];

  const indexAt = (clientX: number, element: SVGSVGElement): number => {
    const box = element.getBoundingClientRect();
    const svgX = ((clientX - box.left) / box.width) * WIDTH;
    const ratio = (svgX - MARGIN.left) / PLOT_WIDTH;
    return Math.round(Math.min(1, Math.max(0, ratio)) * (points.length - 1));
  };

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-labelledby={titleId}
        tabIndex={0}
        className="w-full max-w-2xl rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        onPointerMove={(event) => setActive(indexAt(event.clientX, event.currentTarget))}
        onPointerLeave={() => setActive(null)}
        onFocus={() => setActive((current) => current ?? last)}
        onBlur={() => setActive(null)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          setActive((current) => Math.min(last, Math.max(0, (current ?? last) + (event.key === "ArrowRight" ? 1 : -1))));
        }}
      >
        <title id={titleId}>{label}</title>

        {Y_TICKS.map((tick) => (
          <g key={tick}>
            <line x1={MARGIN.left} x2={WIDTH - MARGIN.right} y1={y(tick)} y2={y(tick)} className="stroke-border" strokeWidth={1} />
            <text x={MARGIN.left - 8} y={y(tick)} textAnchor="end" dominantBaseline="middle" className="fill-muted-foreground text-[11px]">
              {tick}
            </text>
          </g>
        ))}
        {yearTicks.map((tick) => (
          <text key={tick.year} x={x(tick.index)} y={HEIGHT - 6} textAnchor="middle" className="fill-muted-foreground text-[11px]">
            {tick.year}
          </text>
        ))}

        <path d={area} fill="var(--chart-1)" opacity={0.1} />
        <path d={line} fill="none" stroke="var(--chart-1)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

        {/* The latest value is the one direct label; every other month is in the hover readout and the table. */}
        <circle cx={x(last)} cy={y(points[last].value)} r={4} fill="var(--chart-1)" className="stroke-background" strokeWidth={2} />
        <text x={x(last) + 8} y={y(points[last].value)} dominantBaseline="middle" className="fill-foreground text-[12px] font-medium">
          {points[last].value}
        </text>

        {active !== null && shown && (
          <g>
            <line x1={x(active)} x2={x(active)} y1={MARGIN.top} y2={y(0)} className="stroke-muted-foreground" strokeWidth={1} />
            <circle cx={x(active)} cy={y(shown.value)} r={4} fill="var(--chart-1)" className="stroke-background" strokeWidth={2} />
          </g>
        )}
      </svg>

      {active !== null && shown && (
        <div
          role="status"
          className="pointer-events-none absolute top-0 -translate-x-1/2 rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-sm"
          style={{ left: `${Math.min(88, Math.max(12, (x(active) / WIDTH) * 100))}%` }}
        >
          <span className="font-semibold tabular-nums">{shown.value}</span> <span className="text-muted-foreground">{monthLabel(shown.date)}</span>
        </div>
      )}

      <details className="mt-2 text-sm">
        <summary className="cursor-pointer text-muted-foreground">Show data</summary>
        <div className="mt-2 max-h-48 max-w-xs overflow-y-auto rounded-lg border">
          <table className="w-full text-xs tabular-nums">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="px-2 py-1 font-medium">Month</th>
                <th className="px-2 py-1 text-right font-medium">Interest (0–100)</th>
              </tr>
            </thead>
            <tbody>
              {points.map((point) => (
                <tr key={point.date} className="border-b last:border-b-0">
                  <td className="px-2 py-1">{monthLabel(point.date)}</td>
                  <td className="px-2 py-1 text-right">{point.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
