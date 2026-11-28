import { createServerFn } from "@tanstack/react-start";

import { ensureSession } from "#/lib/auth/auth.functions";

import {
  listNotificationsSchema,
  markNotificationReadSchema,
} from "./notifications.schema";

export const listNotifications = createServerFn({ method: "GET" })
  .validator(listNotificationsSchema)
  .handler(async ({ data, context }) => {
    const session = await ensureSession();
    const server = await import("./notifications.server");
    return server.listNotifications({
      db: context.db,
      userId: session.user.id,
      limit: data?.limit,
    });
  });

export const markNotificationRead = createServerFn({ method: "POST" })
  .validator(markNotificationReadSchema)
  .handler(async ({ data, context }) => {
    const session = await ensureSession();
    const server = await import("./notifications.server");
    return server.markNotificationRead({
      db: context.db,
      userId: session.user.id,
      notificationId: data.notificationId,
    });
  });

export const markAllNotificationsRead = createServerFn({
  method: "POST",
}).handler(async ({ context }) => {
  const session = await ensureSession();
  const server = await import("./notifications.server");
  return server.markAllNotificationsRead({
    db: context.db,
    userId: session.user.id,
  });
});
