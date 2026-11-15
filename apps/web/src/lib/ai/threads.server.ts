import type { Db } from "@texfolia/db";
import { aiThread, aiMessage } from "@texfolia/db/schema";
import { and, asc, desc, eq } from "drizzle-orm";

import { AiError } from "./schema";
import { storedMessageSchema, threadActionSchema } from "./threads";

export const threadOwner = (projectId: string, userId: string, id: string) =>
  and(
    eq(aiThread.projectId, projectId),
    eq(aiThread.userId, userId),
    eq(aiThread.id, id),
  );

export async function listAssistantThreads(
  db: Db,
  projectId: string,
  userId: string,
) {
  return db
    .select({
      id: aiThread.id,
      title: aiThread.title,
      model: aiThread.model,
      updatedAt: aiThread.updatedAt,
    })
    .from(aiThread)
    .where(and(eq(aiThread.projectId, projectId), eq(aiThread.userId, userId)))
    .orderBy(desc(aiThread.updatedAt));
}

export async function readAssistantThread(
  db: Db,
  projectId: string,
  userId: string,
  id: string,
) {
  const [thread] = await db
    .select()
    .from(aiThread)
    .where(threadOwner(projectId, userId, id));
  if (!thread) throw new AiError("Chat not found.", 404);
  const rows = await db
    .select()
    .from(aiMessage)
    .where(eq(aiMessage.threadId, thread.id))
    .orderBy(asc(aiMessage.position));
  return {
    thread: {
      id: thread.id,
      title: thread.title,
      model: thread.model,
      updatedAt: thread.updatedAt,
    },
    messages: rows.map((row) => storedMessageSchema.parse(row.message)),
  };
}

export async function manageAssistantThread(
  db: Db,
  projectId: string,
  userId: string,
  body: unknown,
) {
  const parsed = threadActionSchema.safeParse(body);
  if (!parsed.success) throw new AiError("Choose a valid chat action.", 400);
  const action = parsed.data;
  if (action.kind === "create") {
    const [thread] = await db
      .insert(aiThread)
      .values({ projectId, userId, title: action.title })
      .returning();
    if (!thread) throw new AiError("Could not create chat.", 503);
    return {
      thread: {
        id: thread.id,
        title: thread.title,
        model: thread.model,
        updatedAt: thread.updatedAt,
      },
      messages: [],
    };
  }
  return db.transaction(async (tx) => {
    const [thread] = await tx
      .select()
      .from(aiThread)
      .where(threadOwner(projectId, userId, action.id))
      .for("update");
    if (!thread) throw new AiError("Chat not found.", 404);
    if (
      thread.activeRunId &&
      thread.activeRunAt &&
      Date.now() - thread.activeRunAt.getTime() < 5 * 60_000
    )
      throw new AiError(
        "Stop the active reply before changing this chat.",
        409,
      );
    if (action.kind === "delete")
      await tx.delete(aiThread).where(eq(aiThread.id, action.id));
    else
      await tx
        .update(aiThread)
        .set({
          ...(action.kind === "rename"
            ? { title: action.title }
            : { model: action.model }),
          updatedAt: new Date(),
        })
        .where(eq(aiThread.id, action.id));
    return { ok: true };
  });
}
