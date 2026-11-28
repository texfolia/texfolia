import { IconBell, IconCheck } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { cn } from "cn";
import { useCallback, useEffect, useState } from "react";

import { Avatar, AvatarFallback, AvatarImage } from "#/components/ui/avatar";
import { Button } from "#/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "#/lib/notifications/notifications.functions";
import type { NotificationItem } from "#/lib/notifications/notifications.server";

const dateFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function initialsOf(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0];
  if (!first) return "?";
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  return `${first[0] ?? ""}${parts.at(-1)?.[0] ?? ""}`.toUpperCase();
}

export function NotificationsMenu({
  buttonClassName,
  size = "icon-sm",
}: {
  buttonClassName?: string;
  size?: "icon-xs" | "icon-sm" | "icon";
}) {
  const navigate = useNavigate();
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listNotifications({ data: { limit: 30 } });
      setItems(result.items);
      setUnreadCount(result.unreadCount);
    } catch {
      // Keep existing state if offline or unauthenticated.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  async function openNotification(item: NotificationItem) {
    if (!item.readAt) {
      setItems((current) =>
        current.map((entry) =>
          entry.id === item.id ? { ...entry, readAt: new Date() } : entry,
        ),
      );
      setUnreadCount((count) => Math.max(0, count - 1));
      void markNotificationRead({ data: { notificationId: item.id } }).catch(
        () => {},
      );
    }
    await navigate({
      to: "/project/$projectId",
      params: { projectId: item.projectId },
      search:
        item.kind === "comment_mention" && item.threadId
          ? { thread: item.threadId }
          : { view: "scratchpad" },
    });
  }

  async function markAllRead() {
    setItems((current) =>
      current.map((entry) => ({
        ...entry,
        readAt: entry.readAt ?? new Date(),
      })),
    );
    setUnreadCount(0);
    await markAllNotificationsRead().catch(() => {});
  }

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) void refresh();
      }}
    >
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size={size}
            aria-label={
              unreadCount > 0
                ? `Notifications (${unreadCount} unread)`
                : "Notifications"
            }
            title="Notifications"
            className={cn("relative", buttonClassName)}
          />
        }
      >
        <IconBell />
        {unreadCount > 0 && (
          <span
            aria-hidden="true"
            className="bg-primary text-primary-foreground absolute -top-0.5 -right-0.5 flex min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-4 font-medium tabular-nums"
          >
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 max-w-[90vw] p-0">
        <div className="flex items-center justify-between gap-2 px-3 py-2">
          <span className="text-xs font-medium">Notifications</span>
          {unreadCount > 0 && (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className="h-6 px-1.5 text-[11px]"
              onClick={() => void markAllRead()}
            >
              <IconCheck className="size-3" />
              Mark all read
            </Button>
          )}
        </div>
        <DropdownMenuSeparator className="my-0" />
        <div className="max-h-80 overflow-y-auto p-1">
          {!items.length ? (
            <p className="text-muted-foreground px-2 py-6 text-center text-xs">
              {loading ? "Loading notifications…" : "No notifications yet."}
            </p>
          ) : (
            items.map((item) => (
              <DropdownMenuItem
                key={item.id}
                className={cn(
                  "flex items-start gap-2 rounded-md p-2 text-xs",
                  !item.readAt && "bg-muted/50",
                )}
                onClick={() => void openNotification(item)}
              >
                <Avatar size="sm" className="mt-0.5 size-6 shrink-0">
                  {item.actorImage && (
                    <AvatarImage src={item.actorImage} alt="" />
                  )}
                  <AvatarFallback className="text-[10px]">
                    {initialsOf(item.actorName)}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1 space-y-0.5">
                  <p className="leading-snug">
                    <span className="font-medium">{item.actorName}</span>{" "}
                    <span className="text-muted-foreground">
                      {item.kind === "comment_mention"
                        ? "mentioned you in a comment on"
                        : "mentioned you in the scratchpad of"}
                    </span>{" "}
                    <span className="font-medium">{item.projectName}</span>
                  </p>
                  {item.excerpt && (
                    <p className="text-muted-foreground line-clamp-2">
                      {item.excerpt}
                    </p>
                  )}
                  <p className="text-muted-foreground text-[11px]">
                    {dateFormat.format(new Date(item.createdAt))}
                  </p>
                </div>
                {!item.readAt && (
                  <span
                    aria-label="Unread"
                    className="bg-primary mt-1.5 size-2 shrink-0 rounded-full"
                  />
                )}
              </DropdownMenuItem>
            ))
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
