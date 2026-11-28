import { useCallback, useEffect, useState } from "react";

import { Button } from "#/components/ui/button";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "#/components/ui/item";
import {
  NativeSelect,
  NativeSelectOption,
} from "#/components/ui/native-select";
import {
  describeAuditEvent,
  organizationAuditCategories,
  organizationAuditCategoryLabels,
  type OrganizationAuditCategory,
  type OrganizationAuditEventRecord,
} from "#/lib/audit/audit";
import { getOrganizationAuditLog } from "#/lib/audit/audit.functions";
import type { AuditCursor } from "#/lib/audit/audit.server";

function formatTimestamp(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return { iso: "", label: "" };
  return {
    iso: date.toISOString(),
    label: new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date),
  };
}

function actorLabel(event: OrganizationAuditEventRecord) {
  if (!event.actor) return event.actorUserId ? "Deleted user" : "System";
  return event.actor.name.trim() || event.actor.email;
}

/**
 * Append-only audit log viewer for organization owners and admins.
 * Non-admins never mount this section, and the server enforces owner/admin access.
 */
export function OrganizationAuditLog({
  organizationId,
  refreshKey,
}: {
  organizationId: string;
  refreshKey: string;
}) {
  const [category, setCategory] = useState<OrganizationAuditCategory>("all");
  const [events, setEvents] = useState<OrganizationAuditEventRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<AuditCursor | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");

  const loadPage = useCallback(
    async ({
      selectedCategory,
      cursor,
      append,
    }: {
      selectedCategory: OrganizationAuditCategory;
      cursor?: AuditCursor;
      append: boolean;
    }) => {
      if (append) setLoadingMore(true);
      else setLoading(true);
      setError("");
      try {
        const result = await getOrganizationAuditLog({
          data: {
            organizationId,
            category: selectedCategory,
            limit: 25,
            cursor,
          },
        });
        setEvents((prev) =>
          append ? [...prev, ...result.events] : result.events,
        );
        setNextCursor(result.nextCursor);
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : "The audit log could not be loaded. Try again.",
        );
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [organizationId],
  );

  useEffect(() => {
    void loadPage({ selectedCategory: category, append: false });
  }, [loadPage, category, refreshKey]);

  return (
    <Item variant="outline">
      <ItemContent className="gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <ItemTitle>Audit log</ItemTitle>
            <ItemDescription>
              Append-only record of invitations, member and role changes, teams,
              billing, and organization project sharing. Visible to owners and
              admins only.
            </ItemDescription>
          </div>
          <div className="flex items-center gap-2">
            <NativeSelect
              size="sm"
              aria-label="Filter audit log by category"
              value={category}
              disabled={loading}
              onChange={(event) => {
                const next = organizationAuditCategories.find(
                  (item) => item === event.target.value,
                );
                if (next) setCategory(next);
              }}
            >
              {organizationAuditCategories.map((item) => (
                <NativeSelectOption key={item} value={item}>
                  {organizationAuditCategoryLabels[item]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={loading || loadingMore}
              onClick={() =>
                void loadPage({ selectedCategory: category, append: false })
              }
            >
              Refresh
            </Button>
          </div>
        </div>

        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}

        {loading ? (
          <p className="text-muted-foreground text-sm">Loading audit log…</p>
        ) : events.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No audit events recorded yet.
          </p>
        ) : (
          <ul aria-label="Organization audit log" className="divide-y">
            {events.map((event) => {
              const { summary, detail } = describeAuditEvent(event);
              const { iso, label } = formatTimestamp(event.createdAt);
              return (
                <li
                  key={event.id}
                  className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3 text-sm"
                >
                  <div className="min-w-0 space-y-0.5">
                    <p className="font-medium wrap-anywhere">{summary}</p>
                    <p className="text-muted-foreground text-xs wrap-anywhere">
                      {actorLabel(event)}
                      {detail ? ` · ${detail}` : ""}
                    </p>
                  </div>
                  <div className="text-muted-foreground flex shrink-0 items-center gap-2 text-xs">
                    <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-[11px]">
                      {event.action}
                    </code>
                    {iso && (
                      <time dateTime={iso} title={iso}>
                        {label}
                      </time>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {nextCursor && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit"
            disabled={loadingMore}
            onClick={() =>
              void loadPage({
                selectedCategory: category,
                cursor: nextCursor,
                append: true,
              })
            }
          >
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
        )}
      </ItemContent>
    </Item>
  );
}
