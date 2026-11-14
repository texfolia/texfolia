import { createServerFn } from "@tanstack/react-start";
import { env } from "cloudflare:workers";
import { z } from "zod";

import { ensureSession } from "./auth.functions";
import {
  documentVersionSchema,
  historyDocumentSchema,
  historyLabelSchema,
  historyVersionSchema,
} from "./document-history";

export const listDocumentHistory = createServerFn({ method: "GET" })
  .validator(
    historyDocumentSchema.extend({
      before: z.object({ createdAt: z.number(), id: z.uuid() }).optional(),
    }),
  )
  .handler(async ({ data }) => {
    const session = await ensureSession();
    const { versions, next } = await env.COLLABORATION.getByName(
      data.projectId,
    ).listHistory({ ...data, userId: session.user.id });
    return { versions, next };
  });

export const compareDocumentHistory = createServerFn({ method: "GET" })
  .validator(historyVersionSchema)
  .handler(async ({ data }) => {
    const session = await ensureSession();
    const { version, value, current } = await env.COLLABORATION.getByName(
      data.projectId,
    ).compareHistory({ ...data, userId: session.user.id });
    return { version, value, current };
  });

export const createDocumentVersion = createServerFn({ method: "POST" })
  .validator(historyDocumentSchema.extend({ label: historyLabelSchema }))
  .handler(async ({ data }) => {
    const session = await ensureSession();
    return documentVersionSchema.parse(
      await env.COLLABORATION.getByName(data.projectId).createHistory({
        ...data,
        userId: session.user.id,
        name: session.user.name,
      }),
    );
  });

export const nameDocumentVersion = createServerFn({ method: "POST" })
  .validator(historyVersionSchema.extend({ label: historyLabelSchema }))
  .handler(async ({ data }) => {
    const session = await ensureSession();
    return documentVersionSchema.parse(
      await env.COLLABORATION.getByName(data.projectId).nameHistory({
        ...data,
        userId: session.user.id,
      }),
    );
  });

export const restoreDocumentVersion = createServerFn({ method: "POST" })
  .validator(historyVersionSchema)
  .handler(async ({ data }) => {
    const session = await ensureSession();
    const { version, objectKey, updatedAt } = await env.COLLABORATION.getByName(
      data.projectId,
    ).restoreHistory({
      ...data,
      userId: session.user.id,
      name: session.user.name,
    });
    return { version, objectKey, updatedAt };
  });
