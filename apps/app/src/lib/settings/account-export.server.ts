import type { Db } from "@texfolia/db";
import {
  account,
  aiMessage,
  aiRequest,
  aiRun,
  aiSettings,
  aiThread,
  member,
  organization,
  project,
  projectComment,
  projectNode,
  session,
  tag,
  user,
} from "@texfolia/db/schema";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";

import { storedMessageSchema } from "#/lib/ai/threads";
import { nanoDollars } from "#/lib/billing";
import { projectPaths } from "#/lib/projects";
import type { SourceBucket } from "#/lib/storage/server";
import { zipStream, type ZipEntry } from "#/lib/storage/zip";

/**
 * Collects a user's personal and account data for GDPR portability export.
 * Explicitly omits credentials, OAuth tokens, and session tokens.
 */
export async function exportAccountData(db: Db, userId: string) {
  const [
    [profile],
    connectedAccounts,
    sessions,
    organizations,
    [ai],
    projects,
    tags,
    comments,
    aiUsage,
  ] = await Promise.all([
    db
      .select({
        id: user.id,
        name: user.name,
        email: user.email,
        emailVerified: user.emailVerified,
        image: user.image,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      })
      .from(user)
      .where(eq(user.id, userId)),
    db
      .select({
        id: account.id,
        providerId: account.providerId,
        accountId: account.accountId,
        scope: account.scope,
        createdAt: account.createdAt,
        updatedAt: account.updatedAt,
      })
      .from(account)
      .where(eq(account.userId, userId))
      .orderBy(account.createdAt),
    db
      .select({
        id: session.id,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        expiresAt: session.expiresAt,
        ipAddress: session.ipAddress,
        userAgent: session.userAgent,
      })
      .from(session)
      .where(eq(session.userId, userId))
      .orderBy(desc(session.createdAt)),
    db
      .select({
        organizationId: organization.id,
        name: organization.name,
        slug: organization.slug,
        role: member.role,
        joinedAt: member.createdAt,
      })
      .from(member)
      .innerJoin(organization, eq(organization.id, member.organizationId))
      .where(eq(member.userId, userId))
      .orderBy(member.createdAt),
    db
      .select({
        defaultModel: aiSettings.defaultModel,
        monthlyCapNanos: aiSettings.monthlyCapNanos,
      })
      .from(aiSettings)
      .where(eq(aiSettings.userId, userId)),
    db
      .select({
        id: project.id,
        name: project.name,
        mainFile: project.mainFile,
        formatIndent: project.formatIndent,
        formatWrap: project.formatWrap,
        formatWidth: project.formatWidth,
        spellcheckLanguage: project.spellcheckLanguage,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        deletedAt: project.deletedAt,
      })
      .from(project)
      .where(eq(project.ownerId, userId))
      .orderBy(desc(project.updatedAt)),
    db
      .select({
        id: tag.id,
        name: tag.name,
      })
      .from(tag)
      .where(eq(tag.userId, userId))
      .orderBy(tag.name),
    db
      .select({
        id: projectComment.id,
        threadId: projectComment.threadId,
        body: projectComment.body,
        createdAt: projectComment.createdAt,
        editedAt: projectComment.editedAt,
      })
      .from(projectComment)
      .where(eq(projectComment.authorId, userId))
      .orderBy(desc(projectComment.createdAt)),
    db
      .select({
        id: aiRun.id,
        projectId: aiRun.projectId,
        model: aiRun.model,
        status: aiRun.status,
        inputTokens: aiRun.inputTokens,
        outputTokens: aiRun.outputTokens,
        chargedDollars:
          sql<number>`(coalesce(sum(${aiRequest.chargedNanos}), 0) / ${nanoDollars}::numeric)::float8`.as(
            "charged_dollars",
          ),
        createdAt: aiRun.createdAt,
        finishedAt: aiRun.finishedAt,
      })
      .from(aiRun)
      .leftJoin(aiRequest, eq(aiRequest.runId, aiRun.id))
      .where(eq(aiRun.userId, userId))
      .groupBy(aiRun.id)
      .orderBy(desc(aiRun.createdAt)),
  ]);

  return {
    exportedAt: new Date().toISOString(),
    profile: profile ?? null,
    connectedAccounts,
    sessions,
    organizations,
    aiSettings: ai ?? null,
    projects,
    tags,
    comments,
    aiUsage,
  };
}

const encoder = new TextEncoder();
const jsonEntry = (path: string, value: unknown): ZipEntry => ({
  path,
  open: async () => encoder.encode(JSON.stringify(value, null, 2)),
});

/** Names folders after projects, which may hold separators and repeat. */
export function folderNames() {
  const used = new Set<string>();
  return (name: string) => {
    const base =
      name
        // oxlint-disable-next-line no-control-regex
        .replaceAll(/[\x00-\x1f/\\:*?"<>|]/g, "_")
        .slice(0, 100)
        // Windows drops these, which would also join folders.
        .replaceAll(/^[\s.]+|[\s.]+$/g, "") || "project";
    for (let count = 1; ; count++) {
      const folder = count === 1 ? base : `${base} (${count})`;
      // Some file systems ignore case.
      if (used.has(folder.toLowerCase())) continue;
      used.add(folder.toLowerCase());
      return folder;
    }
  };
}

// Extracting the archive must not write outside its folder. New paths are
// checked, but old ones may still need repair.
function safePath(path: string) {
  return path
    .replaceAll("\\", "_")
    .split("/")
    .map((segment) => (/^\.*$/.test(segment) ? "_" : segment))
    .join("/");
}

async function* exportEntries(
  db: Db,
  bucket: Pick<SourceBucket, "get">,
  userId: string,
  data: Awaited<ReturnType<typeof exportAccountData>>,
): AsyncGenerator<ZipEntry> {
  yield jsonEntry("account.json", data);

  const threads = await db
    .select({
      id: aiThread.id,
      title: aiThread.title,
      model: aiThread.model,
      projectId: aiThread.projectId,
      createdAt: aiThread.createdAt,
      updatedAt: aiThread.updatedAt,
      ownerId: project.ownerId,
    })
    .from(aiThread)
    .innerJoin(project, eq(project.id, aiThread.projectId))
    .where(eq(aiThread.userId, userId))
    .orderBy(desc(aiThread.updatedAt));
  for (const { ownerId, ...thread } of threads) {
    const rows = await db
      .select({ message: aiMessage.message, createdAt: aiMessage.createdAt })
      .from(aiMessage)
      .where(eq(aiMessage.threadId, thread.id))
      .orderBy(asc(aiMessage.position));
    const messages = rows.map(({ message, createdAt }) => {
      if (ownerId === userId) return { message, createdAt };
      // Tool calls and reasoning quote files, which stay with their owner.
      const parsed = storedMessageSchema.safeParse(message);
      return {
        message: parsed.success
          ? {
              ...parsed.data,
              parts: parsed.data.parts.filter((part) => part.type === "text"),
            }
          : null,
        createdAt,
      };
    });
    yield jsonEntry(`ai-chats/${thread.id}.json`, { ...thread, messages });
  }

  const missing: string[] = [];
  const folderName = folderNames();
  for (const { id, name } of data.projects) {
    const nodes = await db
      .select({
        id: projectNode.id,
        parentId: projectNode.parentId,
        name: projectNode.name,
        kind: projectNode.kind,
        objectKey: projectNode.objectKey,
      })
      .from(projectNode)
      // It may have been transferred since the export started.
      .innerJoin(
        project,
        and(eq(project.id, projectNode.projectId), eq(project.ownerId, userId)),
      )
      .where(and(eq(projectNode.projectId, id), isNull(projectNode.deletedAt)));
    const paths = projectPaths(nodes);
    const folder = folderName(name);
    for (const node of nodes) {
      const path = paths.get(node.id);
      if (!path) continue;
      const entry = `projects/${folder}/${safePath(path)}`;
      // An empty file has no object.
      const object = node.objectKey ? await bucket.get(node.objectKey) : null;
      if (node.objectKey && !object) {
        missing.push(entry);
        continue;
      }
      const bytes = object
        ? new Uint8Array(await object.arrayBuffer())
        : new Uint8Array();
      yield { path: entry, open: async () => bytes };
    }
  }
  if (missing.length)
    yield {
      path: "missing-files.txt",
      open: async () =>
        encoder.encode(
          `These files could not be read from storage, or changed during the export:\n${missing.join("\n")}\n`,
        ),
    };
}

/**
 * Streams the account's data with its AI chats and the saved sources of the
 * personal projects it owns. `openDb` opens the archive's own connection, because
 * a request's closes before its response is sent.
 */
export function accountArchive({
  openDb,
  bucket,
  userId,
  data,
}: {
  openDb: () => Db;
  bucket: Pick<SourceBucket, "get">;
  userId: string;
  data: Awaited<ReturnType<typeof exportAccountData>>;
}) {
  async function* entries() {
    const db = openDb();
    try {
      yield* exportEntries(db, bucket, userId, data);
    } finally {
      await db.$client.end();
    }
  }
  return zipStream(entries());
}
