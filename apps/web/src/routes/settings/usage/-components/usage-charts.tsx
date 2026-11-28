import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@texfolia/ui/chart";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";

import type {
  DailyAiPoint,
  DailyCompilePoint,
  InvoiceRecord,
  SeatHistoryPoint,
} from "#/lib/billing/usage-analytics";

export const formatUsd = (amount: number, maxFractionDigits = 4) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: maxFractionDigits,
  }).format(amount);

export const formatShortDate = (isoDay: string) => {
  const parts = isoDay.split("-");
  if (parts.length !== 3) return isoDay;
  const date = new Date(
    Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])),
  );
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
};

const aiSpendConfig = {
  chargedDollars: {
    label: "Charged (pre-tax)",
    color: "var(--chart-2)",
  },
  reservedDollars: {
    label: "Reserved (pending)",
    color: "var(--warning)",
  },
  cumulativeDollars: {
    label: "Cumulative spend",
    color: "var(--chart-1)",
  },
} satisfies ChartConfig;

const breakdownConfig = {
  chargedDollars: {
    label: "Charged",
    color: "var(--chart-2)",
  },
  reservedDollars: {
    label: "Reserved",
    color: "var(--warning)",
  },
} satisfies ChartConfig;

const compileCountConfig = {
  succeeded: {
    label: "Succeeded",
    color: "var(--success)",
  },
  failed: {
    label: "Failed",
    color: "var(--destructive)",
  },
} satisfies ChartConfig;

const compileMinutesConfig = {
  minutes: {
    label: "Compile minutes",
    color: "var(--chart-3)",
  },
} satisfies ChartConfig;

const seatHistoryConfig = {
  seats: {
    label: "Paid seats",
    color: "var(--chart-2)",
  },
} satisfies ChartConfig;

const invoiceHistoryConfig = {
  subtotalDollars: {
    label: "Subtotal",
    color: "var(--chart-2)",
  },
  taxDollars: {
    label: "Tax",
    color: "var(--chart-4)",
  },
} satisfies ChartConfig;

export function AiSpendChart({
  data,
  monthlyCapDollars,
  showCapLine,
  mode,
}: {
  data: DailyAiPoint[];
  monthlyCapDollars: number;
  showCapLine: boolean;
  mode: "daily" | "cumulative";
}) {
  if (!data.length) {
    return (
      <p className="text-muted-foreground py-8 text-center text-sm">
        No days in the selected period.
      </p>
    );
  }

  return (
    <ChartContainer
      config={aiSpendConfig}
      role="img"
      aria-label={
        mode === "cumulative"
          ? "Cumulative AI spend versus monthly cap"
          : "Daily AI charged and reserved spend"
      }
      className="aspect-auto h-64 w-full"
    >
      {mode === "cumulative" ? (
        <ComposedChart
          accessibilityLayer
          data={data}
          margin={{ top: 12, right: 16, left: 4, bottom: 4 }}
        >
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={formatShortDate}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={24}
          />
          <YAxis
            tickFormatter={(v: number) => `$${v}`}
            tickLine={false}
            axisLine={false}
            width={52}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={(label) => formatShortDate(String(label))}
                formatter={(value, name) => (
                  <div className="flex flex-1 items-center justify-between gap-4">
                    <span className="text-muted-foreground">
                      {aiSpendConfig[String(name) as keyof typeof aiSpendConfig]
                        ?.label ?? String(name)}
                    </span>
                    <span className="font-mono font-medium tabular-nums">
                      {formatUsd(Number(value))}
                    </span>
                  </div>
                )}
              />
            }
          />
          <ChartLegend content={<ChartLegendContent />} />
          <Bar
            dataKey="chargedDollars"
            stackId="daily"
            fill="var(--color-chargedDollars)"
            radius={[2, 2, 0, 0]}
            fillOpacity={0.35}
          />
          <Bar
            dataKey="reservedDollars"
            stackId="daily"
            fill="var(--color-reservedDollars)"
            radius={[2, 2, 0, 0]}
            fillOpacity={0.5}
          />
          <Line
            type="monotone"
            dataKey="cumulativeDollars"
            stroke="var(--color-cumulativeDollars)"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
          />
          {showCapLine && monthlyCapDollars > 0 && (
            <ReferenceLine
              y={monthlyCapDollars}
              stroke="var(--destructive)"
              strokeDasharray="5 4"
              label={{
                value: `Cap ${formatUsd(monthlyCapDollars, 2)}`,
                position: "insideTopRight",
                fill: "var(--destructive)",
                fontSize: 11,
              }}
            />
          )}
        </ComposedChart>
      ) : (
        <BarChart
          accessibilityLayer
          data={data}
          margin={{ top: 12, right: 16, left: 4, bottom: 4 }}
        >
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={formatShortDate}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={24}
          />
          <YAxis
            tickFormatter={(v: number) => `$${v}`}
            tickLine={false}
            axisLine={false}
            width={52}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={(label) => formatShortDate(String(label))}
                formatter={(value, name) => (
                  <div className="flex flex-1 items-center justify-between gap-4">
                    <span className="text-muted-foreground">
                      {aiSpendConfig[String(name) as keyof typeof aiSpendConfig]
                        ?.label ?? String(name)}
                    </span>
                    <span className="font-mono font-medium tabular-nums">
                      {formatUsd(Number(value))}
                    </span>
                  </div>
                )}
              />
            }
          />
          <ChartLegend content={<ChartLegendContent />} />
          <Bar
            dataKey="chargedDollars"
            stackId="spend"
            fill="var(--color-chargedDollars)"
            radius={[2, 2, 0, 0]}
          />
          <Bar
            dataKey="reservedDollars"
            stackId="spend"
            fill="var(--color-reservedDollars)"
            radius={[2, 2, 0, 0]}
          />
        </BarChart>
      )}
    </ChartContainer>
  );
}

export function AiBreakdownBarChart({
  data,
  ariaLabel,
}: {
  data: { label: string; chargedDollars: number; reservedDollars: number }[];
  ariaLabel: string;
}) {
  const top = data.slice(0, 8);
  if (!top.length) return null;
  const height = Math.max(140, top.length * 34 + 32);
  return (
    <ChartContainer
      config={breakdownConfig}
      role="img"
      aria-label={ariaLabel}
      style={{ height }}
      className="aspect-auto w-full"
    >
      <BarChart
        accessibilityLayer
        data={top}
        layout="vertical"
        margin={{ top: 4, right: 16, left: 8, bottom: 4 }}
      >
        <CartesianGrid horizontal={false} />
        <XAxis
          type="number"
          tickFormatter={(v: number) => `$${v}`}
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          type="category"
          dataKey="label"
          width={140}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v: string) =>
            v.length > 20 ? `${v.slice(0, 19)}…` : v
          }
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              formatter={(value, name) => (
                <div className="flex flex-1 items-center justify-between gap-4">
                  <span className="text-muted-foreground">
                    {breakdownConfig[
                      String(name) as keyof typeof breakdownConfig
                    ]?.label ?? String(name)}
                  </span>
                  <span className="font-mono font-medium tabular-nums">
                    {formatUsd(Number(value))}
                  </span>
                </div>
              )}
            />
          }
        />
        <Bar
          dataKey="chargedDollars"
          stackId="a"
          fill="var(--color-chargedDollars)"
          radius={[0, 3, 3, 0]}
        />
        <Bar
          dataKey="reservedDollars"
          stackId="a"
          fill="var(--color-reservedDollars)"
          radius={[0, 3, 3, 0]}
        />
      </BarChart>
    </ChartContainer>
  );
}

export function CompileActivityChart({
  data,
  metric,
}: {
  data: DailyCompilePoint[];
  metric: "counts" | "minutes";
}) {
  if (!data.length) {
    return (
      <p className="text-muted-foreground py-8 text-center text-sm">
        No compile activity in this period.
      </p>
    );
  }
  return (
    <ChartContainer
      config={metric === "counts" ? compileCountConfig : compileMinutesConfig}
      role="img"
      aria-label={
        metric === "counts"
          ? "Daily compile counts by status"
          : "Daily compile minutes"
      }
      className="aspect-auto h-56 w-full"
    >
      {metric === "counts" ? (
        <BarChart
          accessibilityLayer
          data={data}
          margin={{ top: 8, right: 16, left: 4, bottom: 4 }}
        >
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={formatShortDate}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={24}
          />
          <YAxis
            allowDecimals={false}
            tickLine={false}
            axisLine={false}
            width={40}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={(label) => formatShortDate(String(label))}
              />
            }
          />
          <ChartLegend content={<ChartLegendContent />} />
          <Bar
            dataKey="succeeded"
            stackId="jobs"
            fill="var(--color-succeeded)"
            radius={[2, 2, 0, 0]}
          />
          <Bar
            dataKey="failed"
            stackId="jobs"
            fill="var(--color-failed)"
            radius={[2, 2, 0, 0]}
          />
        </BarChart>
      ) : (
        <AreaChart
          accessibilityLayer
          data={data}
          margin={{ top: 8, right: 16, left: 4, bottom: 4 }}
        >
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={formatShortDate}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={24}
          />
          <YAxis
            tickFormatter={(v: number) => `${v}m`}
            tickLine={false}
            axisLine={false}
            width={44}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={(label) => formatShortDate(String(label))}
                formatter={(value) => (
                  <div className="flex flex-1 items-center justify-between gap-4">
                    <span className="text-muted-foreground">Compile time</span>
                    <span className="font-mono font-medium tabular-nums">
                      {Number(value).toFixed(2)} min
                    </span>
                  </div>
                )}
              />
            }
          />
          <Area
            type="monotone"
            dataKey="minutes"
            stroke="var(--color-minutes)"
            fill="var(--color-minutes)"
            fillOpacity={0.2}
            strokeWidth={2}
          />
        </AreaChart>
      )}
    </ChartContainer>
  );
}

export function SeatHistoryChart({ data }: { data: SeatHistoryPoint[] }) {
  if (!data.length) return null;
  return (
    <ChartContainer
      config={seatHistoryConfig}
      role="img"
      aria-label="Organization paid seat count over time"
      className="aspect-auto h-48 w-full"
    >
      <AreaChart
        accessibilityLayer
        data={data}
        margin={{ top: 8, right: 16, left: 4, bottom: 4 }}
      >
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="date"
          tickFormatter={formatShortDate}
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={24}
        />
        <YAxis
          allowDecimals={false}
          tickLine={false}
          axisLine={false}
          width={36}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(label) => formatShortDate(String(label))}
              formatter={(value) => (
                <div className="flex flex-1 items-center justify-between gap-4">
                  <span className="text-muted-foreground">Paid seats</span>
                  <span className="font-mono font-medium tabular-nums">
                    {Number(value)} seats
                  </span>
                </div>
              )}
            />
          }
        />
        <Area
          type="stepAfter"
          dataKey="seats"
          stroke="var(--color-seats)"
          fill="var(--color-seats)"
          fillOpacity={0.18}
          strokeWidth={2}
        />
      </AreaChart>
    </ChartContainer>
  );
}

export function InvoiceHistoryChart({
  invoices,
}: {
  invoices: InvoiceRecord[];
}) {
  if (invoices.length < 2) return null;
  const chartData = [...invoices].reverse().map((inv) => ({
    date: inv.createdAt.slice(0, 10),
    subtotalDollars: inv.subtotalDollars,
    taxDollars: inv.taxDollars,
  }));
  return (
    <ChartContainer
      config={invoiceHistoryConfig}
      role="img"
      aria-label="Historical invoice subtotals and tax"
      className="aspect-auto h-48 w-full"
    >
      <BarChart
        accessibilityLayer
        data={chartData}
        margin={{ top: 8, right: 16, left: 4, bottom: 4 }}
      >
        <CartesianGrid vertical={false} />
        <XAxis
          dataKey="date"
          tickFormatter={formatShortDate}
          tickLine={false}
          axisLine={false}
          tickMargin={8}
        />
        <YAxis
          tickFormatter={(v: number) => `$${v}`}
          tickLine={false}
          axisLine={false}
          width={52}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(label) => formatShortDate(String(label))}
              formatter={(value, name) => (
                <div className="flex flex-1 items-center justify-between gap-4">
                  <span className="text-muted-foreground">
                    {invoiceHistoryConfig[
                      String(name) as keyof typeof invoiceHistoryConfig
                    ]?.label ?? String(name)}
                  </span>
                  <span className="font-mono font-medium tabular-nums">
                    {formatUsd(Number(value), 2)}
                  </span>
                </div>
              )}
            />
          }
        />
        <ChartLegend content={<ChartLegendContent />} />
        <Bar
          dataKey="subtotalDollars"
          stackId="inv"
          fill="var(--color-subtotalDollars)"
          radius={[2, 2, 0, 0]}
        />
        <Bar
          dataKey="taxDollars"
          stackId="inv"
          fill="var(--color-taxDollars)"
          radius={[2, 2, 0, 0]}
        />
      </BarChart>
    </ChartContainer>
  );
}
