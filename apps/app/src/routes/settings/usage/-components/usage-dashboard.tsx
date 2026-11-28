import { IconDownload, IconExternalLink } from "@tabler/icons-react";
import { Link, useRouter } from "@tanstack/react-router";
import { Button } from "@texfolia/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@texfolia/ui/card";
import { Input } from "@texfolia/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@texfolia/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@texfolia/ui/tabs";
import { useState } from "react";

import type { UsageDashboard, UsagePeriod } from "#/lib/billing";
import { saveOrganizationCap } from "#/lib/billing/billing.functions";
import { formatBytes } from "#/lib/format-bytes";
import { saveAccountAiSettings } from "#/lib/settings/account-settings.functions";

import {
  AiBreakdownBarChart,
  AiSpendChart,
  CompileActivityChart,
  formatUsd,
  InvoiceHistoryChart,
  SeatHistoryChart,
} from "./usage-charts";

const PERIOD_OPTIONS: { id: UsagePeriod; label: string }[] = [
  { id: "current_month", label: "This month" },
  { id: "previous_month", label: "Last month" },
  { id: "last_30_days", label: "Last 30 days" },
  { id: "last_90_days", label: "Last 90 days" },
];

const formatCompactNumber = (value: number) =>
  new Intl.NumberFormat("en-US", {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);

export function UsageDashboardView({
  dashboard,
  onSelectPeriod,
}: {
  dashboard: UsageDashboard;
  onSelectPeriod: (period: UsagePeriod) => void;
}) {
  const router = useRouter();
  const [aiChartMode, setAiChartMode] = useState<"cumulative" | "daily">(
    "cumulative",
  );
  const [compileMetric, setCompileMetric] = useState<"counts" | "minutes">(
    "counts",
  );
  const [cap, setCap] = useState(String(dashboard.ai.monthlyCapDollars));
  const [savedCap, setSavedCap] = useState(cap);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const exportParams = new URLSearchParams({ period: dashboard.period.id });
  if (dashboard.organization) {
    exportParams.set("organizationId", dashboard.organization.id);
  }
  const exportHref = `/api/usage/export?${exportParams.toString()}`;

  const totalTokens =
    dashboard.ai.totalInputTokens + dashboard.ai.totalOutputTokens;
  const clampedCapPercent = Math.min(
    100,
    Math.max(0, dashboard.ai.capUtilizationPercent),
  );
  const capTone =
    dashboard.ai.capUtilizationPercent >= 100
      ? "bg-destructive"
      : dashboard.ai.capUtilizationPercent >= 80
        ? "bg-warning"
        : "bg-primary";

  async function handleSaveCap(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError("");
    setMessage("");
    try {
      const dollars = Number(cap);
      if (dashboard.organization) {
        await saveOrganizationCap({
          data: { organizationId: dashboard.organization.id, dollars },
        });
      } else {
        await saveAccountAiSettings({ data: { kind: "cap", dollars } });
      }
      setSavedCap(cap);
      setMessage(
        dashboard.organization
          ? "Organization monthly cap saved."
          : "Monthly cap saved.",
      );
      await router.invalidate();
    } catch (cause: unknown) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not save cap. Try again.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold">Usage &amp; costs</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            {dashboard.period.label} · Usage spend is shown pre-tax; applicable
            tax is added on invoices.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          render={
            <a href={exportHref} download aria-label="Export usage CSV" />
          }
        >
          <IconDownload className="size-4" />
          Export CSV
        </Button>
      </div>

      {/* Scope and period controls */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <nav aria-label="Usage account" className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant={!dashboard.organization ? "default" : "outline"}
            render={
              <Link
                to="/settings/usage"
                search={{ period: dashboard.period.id }}
              />
            }
          >
            Personal
          </Button>
          {dashboard.organizations.map((org) => (
            <Button
              key={org.id}
              size="sm"
              variant={
                dashboard.organization?.id === org.id ? "default" : "outline"
              }
              render={
                <Link
                  to="/settings/usage"
                  search={{
                    organizationId: org.id,
                    period: dashboard.period.id,
                  }}
                />
              }
            >
              {org.name}
            </Button>
          ))}
        </nav>

        <div
          role="group"
          aria-label="Time period"
          className="flex flex-wrap gap-1.5"
        >
          {PERIOD_OPTIONS.map((option) => (
            <Button
              key={option.id}
              size="sm"
              variant={
                dashboard.period.id === option.id ? "secondary" : "ghost"
              }
              onClick={() => onSelectPeriod(option.id)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>

      {/* KPI summary cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>AI spend (pre-tax)</CardDescription>
            <CardTitle className="text-2xl tabular-nums">
              {formatUsd(dashboard.ai.spentDollars, 2)}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-xs">
            <div className="text-muted-foreground flex justify-between tabular-nums">
              <span>
                Reserved: {formatUsd(dashboard.ai.reservedDollars, 2)}
              </span>
              <span>Cap: {formatUsd(dashboard.ai.monthlyCapDollars, 2)}</span>
            </div>
            <div
              className="bg-muted relative h-2 w-full overflow-hidden rounded-full"
              role="progressbar"
              aria-label="AI cap utilization"
              aria-valuenow={Math.round(dashboard.ai.capUtilizationPercent)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div
                className={`h-full transition-all ${capTone}`}
                style={{ width: `${clampedCapPercent}%` }}
              />
              <div
                className="bg-foreground/30 absolute top-0 bottom-0 w-px"
                style={{ left: "80%" }}
                title="80% threshold"
              />
            </div>
            <p className="text-muted-foreground tabular-nums">
              {dashboard.ai.capUtilizationPercent.toFixed(1)}% of monthly cap
              {dashboard.ai.pendingRequests > 0
                ? ` · ${dashboard.ai.pendingRequests} pending`
                : ""}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>AI tokens</CardDescription>
            <CardTitle
              className="text-2xl tabular-nums"
              title={`${totalTokens.toLocaleString()} total tokens`}
            >
              {formatCompactNumber(totalTokens)}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground space-y-1 text-xs tabular-nums">
            <p>Input: {formatCompactNumber(dashboard.ai.totalInputTokens)}</p>
            <p>Output: {formatCompactNumber(dashboard.ai.totalOutputTokens)}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Compilations</CardDescription>
            <CardTitle className="text-2xl tabular-nums">
              {dashboard.compiles.total.toLocaleString()}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground space-y-1 text-xs tabular-nums">
            <p>
              {dashboard.compiles.succeeded} succeeded ·{" "}
              {dashboard.compiles.failed} failed
            </p>
            <p>{dashboard.compiles.totalMinutes.toFixed(2)} compile minutes</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardDescription>
              {dashboard.seats ? "Team seats & storage" : "Source storage"}
            </CardDescription>
            <CardTitle
              className="text-2xl tabular-nums"
              title={`${BigInt(dashboard.storage.sourceBytes).toLocaleString()} bytes`}
            >
              {dashboard.seats
                ? `${dashboard.seats.currentSeats} ${dashboard.seats.currentSeats === 1 ? "seat" : "seats"}`
                : formatBytes(dashboard.storage.sourceBytes)}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground space-y-1 text-xs tabular-nums">
            {dashboard.seats ? (
              <>
                <p>
                  {formatUsd(
                    dashboard.seats.currentSeats *
                      dashboard.seats.monthlyRateUsd,
                    0,
                  )}
                  /mo excl. tax
                </p>
                <p>
                  Storage: {formatBytes(dashboard.storage.sourceBytes)} (
                  {dashboard.storage.projectCount}{" "}
                  {dashboard.storage.projectCount === 1
                    ? "project"
                    : "projects"}
                  )
                </p>
              </>
            ) : (
              <p>
                Across {dashboard.storage.projectCount}{" "}
                {dashboard.storage.projectCount === 1 ? "project" : "projects"}.
                Excludes deleted sources &amp; compile artifacts.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* AI Spend Over Time + Cap Editor */}
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle>AI spend over time</CardTitle>
            <CardDescription>
              Charged and reserved usage (pre-tax)
              {dashboard.period.isCalendarMonth
                ? " plotted against your monthly cap"
                : ""}
              .
            </CardDescription>
          </div>
          <div className="flex gap-1.5">
            <Button
              size="sm"
              variant={aiChartMode === "cumulative" ? "secondary" : "ghost"}
              onClick={() => setAiChartMode("cumulative")}
            >
              Cumulative vs cap
            </Button>
            <Button
              size="sm"
              variant={aiChartMode === "daily" ? "secondary" : "ghost"}
              onClick={() => setAiChartMode("daily")}
            >
              Daily bars
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <AiSpendChart
            data={dashboard.ai.daily}
            monthlyCapDollars={dashboard.ai.monthlyCapDollars}
            showCapLine={dashboard.period.isCalendarMonth}
            mode={aiChartMode}
          />

          {dashboard.ai.needsReview && (
            <p role="status" className="text-warning text-sm">
              Some AI requests are awaiting billing reconciliation.
            </p>
          )}

          {dashboard.ai.stripeMeterSummary.status === "ok" &&
            dashboard.ai.stripeMeterSummary.totalDollars !== null && (
              <p className="text-muted-foreground text-xs tabular-nums">
                Stripe meter total for this period:{" "}
                <strong>
                  {formatUsd(dashboard.ai.stripeMeterSummary.totalDollars)}
                </strong>{" "}
                (eventually consistent with local charged spend of{" "}
                {formatUsd(dashboard.ai.spentDollars)}).
              </p>
            )}

          <form
            className="space-y-3 border-t pt-4"
            onSubmit={(event) => void handleSaveCap(event)}
          >
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="flex-1 space-y-1.5">
                <label htmlFor="ai-cap" className="text-sm font-medium">
                  {dashboard.organization
                    ? "Organization monthly AI spend cap (USD)"
                    : "Monthly AI spend cap (USD)"}
                </label>
                <Input
                  id="ai-cap"
                  type="number"
                  min={0}
                  max={10000}
                  step="0.01"
                  required
                  value={cap}
                  onChange={(event) => setCap(event.target.value)}
                  disabled={pending}
                />
              </div>
              <Button type="submit" disabled={pending || cap === savedCap}>
                {pending ? "Saving…" : "Save cap"}
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">
              A $0 cap prevents new AI requests. Model cost includes the 20%
              markup. Caps apply to pre-tax usage; applicable tax is added on
              the invoice.
            </p>
            {error && (
              <p role="alert" className="text-destructive text-sm">
                {error}
              </p>
            )}
            {message && (
              <p role="status" className="text-muted-foreground text-sm">
                {message}
              </p>
            )}
          </form>
        </CardContent>
      </Card>

      {/* AI Breakdowns: Model / Project / Member */}
      <Card>
        <CardHeader>
          <CardTitle>AI spend breakdown</CardTitle>
          <CardDescription>
            Pre-tax spend and token usage by model, project
            {dashboard.organization ? ", and organization member" : ""}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="model">
            <TabsList>
              <TabsTrigger value="model">By model</TabsTrigger>
              <TabsTrigger value="project">By project</TabsTrigger>
              {dashboard.organization && (
                <TabsTrigger value="member">By member</TabsTrigger>
              )}
            </TabsList>

            <TabsContent value="model" className="mt-4 space-y-4">
              {dashboard.ai.byModel.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  No AI usage recorded in this period.
                </p>
              ) : (
                <>
                  <AiBreakdownBarChart
                    ariaLabel="AI spend by model"
                    data={dashboard.ai.byModel.map((row) => ({
                      label: row.model,
                      chargedDollars: row.chargedDollars,
                      reservedDollars: row.reservedDollars,
                    }))}
                  />
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Model</TableHead>
                        <TableHead className="text-right">Requests</TableHead>
                        <TableHead className="text-right">Tokens</TableHead>
                        <TableHead className="text-right">
                          Charged (pre-tax)
                        </TableHead>
                        <TableHead className="text-right">Reserved</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {dashboard.ai.byModel.map((row) => (
                        <TableRow key={row.model}>
                          <TableCell className="font-mono text-xs">
                            {row.model}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {row.requests}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatCompactNumber(
                              row.inputTokens + row.outputTokens,
                            )}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatUsd(row.chargedDollars)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatUsd(row.reservedDollars)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </>
              )}
            </TabsContent>

            <TabsContent value="project" className="mt-4 space-y-4">
              {dashboard.ai.byProject.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  No project AI usage recorded in this period.
                </p>
              ) : (
                <>
                  <AiBreakdownBarChart
                    ariaLabel="AI spend by project"
                    data={dashboard.ai.byProject.map((row) => ({
                      label: row.projectName,
                      chargedDollars: row.chargedDollars,
                      reservedDollars: row.reservedDollars,
                    }))}
                  />
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Project</TableHead>
                        <TableHead className="text-right">Requests</TableHead>
                        <TableHead className="text-right">Tokens</TableHead>
                        <TableHead className="text-right">
                          Charged (pre-tax)
                        </TableHead>
                        <TableHead className="text-right">Reserved</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {dashboard.ai.byProject.map((row) => (
                        <TableRow key={row.projectId}>
                          <TableCell>{row.projectName}</TableCell>
                          <TableCell className="text-right tabular-nums">
                            {row.requests}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatCompactNumber(
                              row.inputTokens + row.outputTokens,
                            )}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatUsd(row.chargedDollars)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatUsd(row.reservedDollars)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </>
              )}
            </TabsContent>

            {dashboard.organization && (
              <TabsContent value="member" className="mt-4 space-y-4">
                {dashboard.ai.byMember.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    No member AI usage billed to this organization in this
                    period.
                  </p>
                ) : (
                  <>
                    <AiBreakdownBarChart
                      ariaLabel="AI spend by organization member"
                      data={dashboard.ai.byMember.map((row) => ({
                        label: row.name || row.email,
                        chargedDollars: row.chargedDollars,
                        reservedDollars: row.reservedDollars,
                      }))}
                    />
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Member</TableHead>
                          <TableHead className="text-right">Requests</TableHead>
                          <TableHead className="text-right">Tokens</TableHead>
                          <TableHead className="text-right">
                            Charged (pre-tax)
                          </TableHead>
                          <TableHead className="text-right">Reserved</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {dashboard.ai.byMember.map((row) => (
                          <TableRow key={row.userId}>
                            <TableCell>
                              <div className="font-medium">{row.name}</div>
                              {row.email && (
                                <div className="text-muted-foreground text-xs">
                                  {row.email}
                                </div>
                              )}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {row.requests}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {formatCompactNumber(
                                row.inputTokens + row.outputTokens,
                              )}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {formatUsd(row.chargedDollars)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {formatUsd(row.reservedDollars)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </>
                )}
              </TabsContent>
            )}
          </Tabs>
        </CardContent>
      </Card>

      {/* Compilations */}
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle>Compilations</CardTitle>
            <CardDescription>
              Compile jobs and duration across{" "}
              {dashboard.organization
                ? `${dashboard.organization.name}'s`
                : "accessible"}{" "}
              projects.
            </CardDescription>
          </div>
          <div className="flex gap-1.5">
            <Button
              size="sm"
              variant={compileMetric === "counts" ? "secondary" : "ghost"}
              onClick={() => setCompileMetric("counts")}
            >
              Job counts
            </Button>
            <Button
              size="sm"
              variant={compileMetric === "minutes" ? "secondary" : "ghost"}
              onClick={() => setCompileMetric("minutes")}
            >
              Compile minutes
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <CompileActivityChart
            data={dashboard.compiles.daily}
            metric={compileMetric}
          />
          {dashboard.compiles.byProject.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Project</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">Succeeded</TableHead>
                  <TableHead className="text-right">Failed</TableHead>
                  <TableHead className="text-right">Minutes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {dashboard.compiles.byProject.slice(0, 10).map((row) => (
                  <TableRow key={row.projectId}>
                    <TableCell>{row.projectName}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.total}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.succeeded}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.failed}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.minutes.toFixed(2)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Storage & Team Seats */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card className={dashboard.seats ? "" : "lg:col-span-2"}>
          <CardHeader>
            <CardTitle>Source storage</CardTitle>
            <CardDescription>
              Current saved source bytes across {dashboard.storage.projectCount}{" "}
              {dashboard.storage.projectCount === 1 ? "project" : "projects"}.
              Excludes deleted sources and compile artifacts.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <p
              className="text-2xl font-semibold tabular-nums"
              title={`${BigInt(dashboard.storage.sourceBytes).toLocaleString()} bytes`}
            >
              {formatBytes(dashboard.storage.sourceBytes)}
            </p>
            {dashboard.storage.byProject.length > 0 && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Project</TableHead>
                    <TableHead className="text-right">Source size</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {dashboard.storage.byProject.slice(0, 8).map((row) => (
                    <TableRow key={row.projectId}>
                      <TableCell>{row.projectName}</TableCell>
                      <TableCell
                        className="text-right tabular-nums"
                        title={`${BigInt(row.sourceBytes).toLocaleString()} bytes`}
                      >
                        {formatBytes(row.sourceBytes)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {dashboard.seats && (
          <Card>
            <CardHeader>
              <CardTitle>Seat history</CardTitle>
              <CardDescription>
                {dashboard.seats.currentSeats} paid{" "}
                {dashboard.seats.currentSeats === 1 ? "seat" : "seats"} (
                {dashboard.seats.memberCount} current{" "}
                {dashboard.seats.memberCount === 1 ? "member" : "members"}) at $
                {dashboard.seats.monthlyRateUsd}/seat/month, excluding
                applicable tax.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <SeatHistoryChart data={dashboard.seats.history} />
            </CardContent>
          </Card>
        )}
      </div>

      {/* Estimated Invoice & Invoice History */}
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle>Invoices &amp; estimated bill</CardTitle>
            <CardDescription>
              Official invoices include applicable tax when Stripe Tax is
              enabled.
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            render={
              <Link
                to="/settings/billing"
                search={
                  dashboard.organization
                    ? { organizationId: dashboard.organization.id }
                    : { plan: "pro" }
                }
              />
            }
          >
            Manage in Billing
          </Button>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Current-period estimated invoice (NAT-489 consumer) */}
          <div className="rounded-lg border p-4">
            <h3 className="text-sm font-medium">
              Current-period estimated invoice
            </h3>
            {dashboard.billing.estimatedInvoice.status === "available" ? (
              <div className="mt-3 space-y-3">
                <dl className="grid grid-cols-3 gap-4 text-sm">
                  <div>
                    <dt className="text-muted-foreground text-xs">Subtotal</dt>
                    <dd className="font-medium tabular-nums">
                      {formatUsd(
                        dashboard.billing.estimatedInvoice.subtotalDollars ?? 0,
                        2,
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground text-xs">
                      Estimated tax
                    </dt>
                    <dd className="font-medium tabular-nums">
                      {formatUsd(
                        dashboard.billing.estimatedInvoice.taxDollars ?? 0,
                        2,
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground text-xs">
                      Estimated total
                    </dt>
                    <dd className="font-semibold tabular-nums">
                      {formatUsd(
                        dashboard.billing.estimatedInvoice.totalDollars ?? 0,
                        2,
                      )}
                    </dd>
                  </div>
                </dl>
                {dashboard.billing.estimatedInvoice.lines.length > 0 && (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Line item</TableHead>
                        <TableHead className="text-right">Qty</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {dashboard.billing.estimatedInvoice.lines.map(
                        (line, idx) => (
                          <TableRow key={`${line.description}-${idx}`}>
                            <TableCell>{line.description}</TableCell>
                            <TableCell className="text-right tabular-nums">
                              {line.quantity ?? "—"}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {formatUsd(line.amountDollars, 2)}
                            </TableCell>
                          </TableRow>
                        ),
                      )}
                    </TableBody>
                  </Table>
                )}
              </div>
            ) : (
              <p className="text-muted-foreground mt-1.5 text-sm">
                {dashboard.billing.estimatedInvoice.note}{" "}
                <Link
                  to="/settings/billing"
                  search={
                    dashboard.organization
                      ? { organizationId: dashboard.organization.id }
                      : { plan: "pro" }
                  }
                  className="text-foreground underline underline-offset-4"
                >
                  Open Billing &amp; Customer Portal
                </Link>
              </p>
            )}
          </div>

          {/* Historical invoices */}
          <div className="space-y-4">
            <h3 className="text-sm font-medium">Invoice history</h3>
            {dashboard.billing.invoices.status === "ok" &&
            dashboard.billing.invoices.items.length > 0 ? (
              <>
                <InvoiceHistoryChart
                  invoices={dashboard.billing.invoices.items}
                />
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Invoice</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Subtotal</TableHead>
                      <TableHead className="text-right">Tax</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                      <TableHead className="text-right">PDF</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {dashboard.billing.invoices.items.map((inv) => (
                      <TableRow key={inv.id}>
                        <TableCell className="tabular-nums">
                          {inv.createdAt.slice(0, 10)}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {inv.number ?? inv.id}
                        </TableCell>
                        <TableCell className="capitalize">
                          {inv.status ?? "—"}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatUsd(inv.subtotalDollars, 2)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatUsd(inv.taxDollars, 2)}
                        </TableCell>
                        <TableCell className="text-right font-medium tabular-nums">
                          {formatUsd(inv.totalDollars, 2)}
                        </TableCell>
                        <TableCell className="text-right">
                          {inv.invoicePdf || inv.hostedInvoiceUrl ? (
                            <a
                              href={
                                inv.invoicePdf ?? inv.hostedInvoiceUrl ?? "#"
                              }
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 underline underline-offset-4"
                            >
                              View
                              <IconExternalLink className="size-3.5" />
                            </a>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </>
            ) : (
              <p className="text-muted-foreground text-sm">
                {dashboard.billing.invoices.note ??
                  "No invoices have been issued yet."}
              </p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
