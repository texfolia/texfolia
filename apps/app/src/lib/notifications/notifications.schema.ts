import { z } from "zod";

export const listNotificationsSchema = z
  .object({
    limit: z.number().int().min(1).max(100).optional(),
  })
  .optional();

export const markNotificationReadSchema = z.object({
  notificationId: z.uuid(),
});
