// A line and nothing else. No axes, no grid, no tooltip — it lives inside a
// card and its only job is to show the SHAPE of the last two minutes.

import { LineChart, Line, YAxis, ResponsiveContainer } from 'recharts';

export function Sparkline({ data, dataKey = 'mem_pct', stroke = 'currentColor', height = 36 }) {
  if (!data || data.length < 2) {
    return <div style={{ height }} className="w-full rounded bg-muted/40" />;
  }

  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 2, right: 0, bottom: 2, left: 0 }}>
          {/* Fixed 0–100 domain so a flat 5% line looks flat, not full-height */}
          <YAxis domain={[0, 100]} hide />
          <Line
            type="monotone"
            dataKey={dataKey}
            stroke={stroke}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
