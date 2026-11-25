import type { Db } from "@texfolia/db";
import {
  account,
  member,
  project,
  projectCollaboration,
  projectGit,
  projectNode,
} from "@texfolia/db/schema";
import { and, eq, isNull, inArray } from "drizzle-orm";
import * as git from "isomorphic-git";

import { isOrgAdmin } from "#/lib/auth/roles";
import { requestCollaborationCleanup } from "#/lib/collaboration/server";
import { mapLimit } from "#/lib/map-limit";
import { projectPaths } from "#/lib/projects";
import type { LockProject, ProjectTransaction } from "#/lib/projects/server";
import {
  commitSources,
  deletePrefix,
  prepareSourceBytes,
  retireSources,
  type SourceBucket,
  type SourceUpload,
} from "#/lib/storage/server";

import { gitProvider, gitProviders, hasRepositoryAccess } from "./providers";
import { GitRepository, gitHttp, type GitFiles } from "./repository";
import {
  gitRemoteSchema,
  type GitAction,
  type GitProvider,
  type GitResult,
} from "./schema";

/** Which Git platforms a user has connected with repository access. */
export async function gitAccounts({ db, userId }: { db: Db; userId: string }) {
  const accounts = await db
    .select({ provider: account.providerId, scope: account.scope })
    .from(account)
    .where(eq(account.userId, userId));
  return Object.fromEntries(
    gitProviders.map(({ id }) => [
      id,
      accounts.some(
        (a) => a.provider === id && hasRepositoryAccess(id, a.scope),
      ),
    ]),
  ) as Record<GitProvider, boolean>;
}

/**
 * The user's linked OAuth account for a platform. Throws unless it grants
 * repository access. The app exchanges it for an access token.
 */
export async function gitAccount({
  db,
  userId,
  provider,
}: {
  db: Db;
  userId: string;
  provider: GitProvider;
}) {
  const [linked] = await db
    .select()
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, provider)));
  if (!linked || !hasRepositoryAccess(provider, linked.scope))
    throw new Error(
      `Connect ${gitProvider(provider).label} repository access first.`,
    );
  return linked;
}

/** Returns an OAuth access token for the user's account on `provider`. */
export type GitAccessToken = (request: {
  db: Db;
  userId: string;
  provider: GitProvider;
}) => Promise<string>;

type GitNode = typeof projectNode.$inferSelect;

async function readNodes(tx: ProjectTransaction, projectId: string) {
  return tx
    .select()
    .from(projectNode)
    .where(
      and(eq(projectNode.projectId, projectId), isNull(projectNode.deletedAt)),
    );
}

// Node identity, placement and content version; any change means a concurrent edit.
function nodeVersions(nodes: GitNode[]) {
  return JSON.stringify(
    nodes
      .map((node) => [
        node.id,
        node.parentId,
        node.name,
        node.kind,
        node.objectKey,
        node.updatedAt.getTime(),
      ])
      .sort(([a], [b]) => String(a).localeCompare(String(b))),
  );
}

const readConcurrency = 8;

class MissingObjectError extends Error {}

// Reads every file. `cache` holds sources read earlier, by key, so reading the
// project again only loads what changed.
async function readFiles(
  bucket: SourceBucket,
  nodes: GitNode[],
  cache: Map<string, Uint8Array>,
) {
  const paths = projectPaths(nodes);
  const queue = nodes.flatMap((node) => {
    const path = paths.get(node.id);
    return path ? [{ objectKey: node.objectKey, path }] : [];
  });
  const files: GitFiles = {};
  await mapLimit(queue, readConcurrency, async ({ objectKey, path }) => {
    let bytes = objectKey ? cache.get(objectKey) : new Uint8Array();
    if (objectKey && !bytes) {
      const object = await bucket.get(objectKey);
      if (!object)
        throw new MissingObjectError("Saved project source is missing.");
      bytes = new Uint8Array(await object.arrayBuffer());
      cache.set(objectKey, bytes);
    }
    files[path] = bytes ?? new Uint8Array();
  });
  return files;
}

async function requireRemoteManager(
  tx: ProjectTransaction,
  found: { organizationId: string | null; ownerId: string | null },
  userId: string,
) {
  if (found.organizationId) {
    const [membership] = await tx
      .select()
      .from(member)
      .where(
        and(
          eq(member.organizationId, found.organizationId),
          eq(member.userId, userId),
        ),
      );
    if (!membership || !isOrgAdmin(membership.role))
      throw new Error(
        "Only project owners and organization admins can link or unlink a remote.",
      );
  } else if (found.ownerId !== userId)
    throw new Error("Only the project owner can link or unlink a remote.");
}

async function replaceFiles(
  tx: ProjectTransaction,
  projectId: string,
  files: Map<string, SourceUpload>,
  nodes: GitNode[],
) {
  const root = nodes.find(
    (node) => node.parentId === null && node.kind === "folder",
  );
  if (!root) throw new Error("Project root is missing.");
  const paths = projectPaths(nodes);
  const byPath = new Map(
    nodes.flatMap((node) => {
      const path = paths.get(node.id);
      return path ? [[path, node] as const] : [];
    }),
  );
  // Rebuild folders and reuse file IDs so open Yjs rooms retain their identity.
  const removed = nodes.filter(
    (node) =>
      node.id !== root.id &&
      (node.kind === "folder" || !files.has(paths.get(node.id) ?? "")),
  );
  await retireSources(
    tx,
    projectId,
    removed.map((node) => node.objectKey),
  );
  if (removed.length) {
    await requestCollaborationCleanup(tx, projectId);
    await tx
      .update(projectNode)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(
        inArray(
          projectNode.id,
          removed.map((n) => n.id),
        ),
      );
  }
  const parents = new Map([["", root.id]]);
  for (const [path, { bytes, objectKey, sizeBytes }] of files) {
    const parts = path.split("/");
    const name = parts.pop();
    if (!name) throw new Error("Invalid git file name");
    let prefix = "";
    let parentId = root.id;
    for (const part of parts) {
      prefix = prefix ? `${prefix}/${part}` : part;
      const existing = parents.get(prefix);
      if (existing) {
        parentId = existing;
        continue;
      }
      const id = crypto.randomUUID();
      await tx.insert(projectNode).values({
        id,
        projectId,
        parentId,
        name: part,
        kind: "folder",
        sizeBytes: 0n,
      });
      parents.set(prefix, id);
      parentId = id;
    }
    let kind: "text" | "binary" = "text";
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (bytes.includes(0)) kind = "binary";
    } catch {
      kind = "binary";
    }
    const existing = byPath.get(path);
    if (existing && existing.objectKey !== objectKey)
      await retireSources(tx, projectId, [existing.objectKey]);
    const values = {
      parentId,
      name,
      kind,
      objectKey,
      sizeBytes,
      updatedAt: new Date(),
    };
    if (existing)
      await tx
        .update(projectNode)
        .set(values)
        .where(eq(projectNode.id, existing.id));
    else
      await tx
        .insert(projectNode)
        .values({ id: crypto.randomUUID(), projectId, ...values });
  }
  await tx
    .update(project)
    .set({ updatedAt: new Date() })
    .where(eq(project.id, projectId));
}

// Status bar branch from the cached row; the full status restores the repository.
// Legacy Texfolia-hosted repositories (no remote) show no branch.
export async function gitBranch({
  db,
  lock,
  projectId,
  userId,
}: {
  db: Db;
  /** Locks the project row and checks the user's access. */
  lock: LockProject;
  projectId: string;
  userId: string;
}) {
  return db.transaction(async (tx) => {
    await lock({ tx, projectId, userId, access: "read" });
    const [linked] = await tx
      .select({ branch: projectGit.branch, url: projectGit.url })
      .from(projectGit)
      .where(eq(projectGit.projectId, projectId));
    return linked?.url ? linked.branch : null;
  });
}

// Cheap signal for the workspace metadata poll: changes whenever the linked
// repository is created, updated, or unlinked.
export async function gitVersion(tx: ProjectTransaction, projectId: string) {
  const [linked] = await tx
    .select({ objectKey: projectGit.objectKey })
    .from(projectGit)
    .where(eq(projectGit.projectId, projectId));
  return linked?.objectKey ?? "";
}

// Repositories created by the removed "initialize" action have no remote. They can
// still be read, linked to an empty remote (keeping history) or unlinked.
const hostedRepositoryMessage =
  "Texfolia no longer hosts Git repositories. Link an empty repository to push this history, or unlink it.";

export async function runGit({
  db,
  bucket,
  lock,
  accessToken,
  projectId,
  user,
  action,
  exclusively = (apply) => apply(),
}: {
  db: Db;
  bucket: SourceBucket;
  /** Locks the project row and checks the user's access. */
  lock: LockProject;
  accessToken: GitAccessToken;
  /**
   * Runs the part of an action that rewrites files, holding off other edits and
   * saving accepted ones first. Never runs during a request to the Git host.
   */
  exclusively?: <T>(apply: () => Promise<T>) => Promise<T>;
  projectId: string;
  user: { id: string; name: string; email: string };
  action: GitAction;
}): Promise<GitResult> {
  const readOnly = action.kind === "status" || action.kind === "diff";
  const access = readOnly ? "read" : "write";
  const empty = {
    remote: null,
    branch: null,
    branches: [],
    changes: [],
    commits: [],
  };
  let host = "the host";
  try {
    const changedMessage =
      "The project changed while Git was syncing. Nothing was applied; try again.";
    const cache = new Map<string, Uint8Array>();
    const readSnapshot = () =>
      db.transaction(async (tx) => {
        const found = await lock({
          tx,
          projectId,
          userId: user.id,
          access,
        });
        if (action.kind === "link" || action.kind === "unlink")
          await requireRemoteManager(tx, found, user.id);
        if (action.kind === "unlink") {
          await tx
            .delete(projectGit)
            .where(eq(projectGit.projectId, projectId));
          return null;
        }
        const [linked] = await tx
          .select()
          .from(projectGit)
          .where(eq(projectGit.projectId, projectId));
        if (!linked && readOnly) return null;
        const nodes = await readNodes(tx, projectId);
        return { linked, nodes };
      });
    const loadSnapshotObjects = async (
      linked: typeof projectGit.$inferSelect | undefined,
      nodes: GitNode[],
    ) => {
      const [saved, files] = await Promise.all([
        linked
          ? bucket.get(linked.objectKey).then(async (object) => {
              if (!object)
                throw new MissingObjectError(
                  "Saved git repository is missing.",
                );
              return object.text();
            })
          : Promise.resolve(null),
        action.kind === "import"
          ? Promise.resolve<GitFiles>({})
          : readFiles(bucket, nodes, cache),
      ]);
      return { saved, files };
    };
    // Short snapshot transaction: no R2 reads or Git host requests while the project row is locked.
    const snapshot = await readSnapshot();
    if (!snapshot) return { status: empty };
    let { linked, nodes } = snapshot;
    const connecting = action.kind === "link" || action.kind === "import";
    if (connecting && linked?.url)
      throw new Error(
        "Unlink the current repository before connecting another.",
      );
    if (!connecting && !linked?.url && !readOnly)
      throw new Error(
        linked
          ? hostedRepositoryMessage
          : "Link a repository first, or import one as a new project.",
      );
    let remote = connecting
      ? action.remote
      : linked?.url
        ? gitRemoteSchema.parse(linked.url)
        : null;
    if (remote) host = gitProvider(remote.provider).label;
    let saved: string | null;
    let files: GitFiles;
    try {
      ({ saved, files } = await loadSnapshotObjects(linked, nodes));
    } catch (error) {
      if (!(error instanceof MissingObjectError)) throw error;
      // An object may have been retired and garbage-collected after the
      // snapshot lock was released. Re-check the DB before reporting corruption.
      const latest = await readSnapshot();
      const changed =
        latest?.linked?.objectKey !== linked?.objectKey ||
        nodeVersions(latest?.nodes ?? []) !== nodeVersions(nodes);
      if (!changed) throw error;
      if (!readOnly) throw new Error(changedMessage);
      if (!latest) return { status: empty };
      ({ linked, nodes } = latest);
      remote = linked?.url ? gitRemoteSchema.parse(linked.url) : null;
      if (remote) host = gitProvider(remote.provider).label;
      ({ saved, files } = await loadSnapshotObjects(linked, nodes));
    }
    const repo = saved ? GitRepository.restore(saved) : new GitRepository();
    let http: git.HttpClient | undefined;
    if (
      remote &&
      (connecting ||
        action.kind === "push" ||
        action.kind === "pull" ||
        (action.kind === "checkout" &&
          !(await repo.hasLocalBranch(action.name))) ||
        action.kind === "fetch")
    )
      http = gitHttp(
        remote.url,
        await accessToken({ db, userId: user.id, provider: remote.provider }),
        gitProvider(remote.provider).tokenUsername,
      );
    const author = { name: user.name || "Texfolia user", email: user.email };
    // Saves the repository and, when pulling or switching branches, its files.
    // Applies only if nothing changed since the snapshot.
    const save = async (replaced?: GitNode[]) => {
      const files = new Map<string, SourceUpload>();
      if (replaced)
        for (const [path, bytes] of Object.entries(repo.sources()))
          files.set(
            path,
            await prepareSourceBytes(projectId, new Uint8Array(bytes)),
          );
      const stored = new Set(replaced?.map((node) => node.objectKey));
      // Collection leaves recent clones alone until a row refers to them.
      const objectKey = `git/${projectId}/${crypto.randomUUID()}.json`;
      await bucket.put(objectKey, repo.serialize());
      const values = {
        provider: remote?.provider ?? null,
        url: remote?.url ?? null,
        objectKey,
        branch: await repo.currentBranch(),
      };
      const run = async (tx: ProjectTransaction) => {
        const found = await lock({
          tx,
          projectId,
          userId: user.id,
          access,
        });
        if (action.kind === "link")
          await requireRemoteManager(tx, found, user.id);
        const [current] = await tx
          .select()
          .from(projectGit)
          .where(eq(projectGit.projectId, projectId));
        if (current?.objectKey !== linked?.objectKey)
          throw new Error(changedMessage);
        if (replaced) {
          const latest = await readNodes(tx, projectId);
          if (nodeVersions(latest) !== nodeVersions(replaced))
            throw new Error(changedMessage);
          await replaceFiles(tx, projectId, files, latest);
        }
        await tx
          .insert(projectGit)
          .values({ projectId, ...values })
          .onConflictDoUpdate({ target: projectGit.projectId, set: values });
        await tx
          .insert(projectCollaboration)
          .values({ projectId })
          .onConflictDoNothing();
      };
      await commitSources({
        db,
        bucket,
        projectId,
        // Files that live nodes already store stay stored until this commits.
        uploads: [...files.values()].filter(
          (file) => !stored.has(file.objectKey),
        ),
        run,
      });
    };
    // Rewrites the project's files from the repository, as they are by now.
    const replace = (change: () => Promise<unknown>) =>
      exclusively(async () => {
        const latest = await readSnapshot();
        if (!latest || latest.linked?.objectKey !== linked?.objectKey)
          throw new Error(changedMessage);
        if (action.kind !== "import")
          repo.overlay(await readFiles(bucket, latest.nodes, cache));
        await change();
        await save(latest.nodes);
      });
    if (action.kind === "link" && http && remote)
      await repo.requireEmptyRemote(remote.url, http);
    if (action.kind !== "import") repo.overlay(files);
    switch (action.kind) {
      case "import":
        if (http && remote) await repo.clone(remote.url, http);
        await replace(async () => {});
        break;
      case "pull":
        if (http) {
          await repo.requireClean();
          const fetched = await repo.fetchCurrent(http);
          await replace(() => repo.merge(fetched, author));
        }
        break;
      case "checkout": {
        const { name } = action;
        await repo.requireClean();
        if (http) await repo.fetchBranch(name, http);
        await replace(() => repo.switchBranch(name));
        break;
      }
      case "fetch":
        if (http && remote) await repo.remoteBranches(http, remote.url);
        await save();
        break;
      case "commit":
        await repo.commit(action.message, author);
        await save();
        break;
      case "push":
        if (http) await repo.push(http);
        await save();
        break;
      case "branch":
        await repo.branch(action.name);
        await save();
        break;
      case "link":
        await save();
        break;
      case "status":
      case "diff":
      case "unlink":
        break;
    }
    const status = await repo.status();
    if (readOnly && linked && linked.branch !== status.branch)
      // Backfill rows saved before the branch was cached.
      await db
        .update(projectGit)
        .set({ branch: status.branch })
        .where(
          and(
            eq(projectGit.projectId, projectId),
            eq(projectGit.objectKey, linked.objectKey),
          ),
        );
    return {
      status: { remote, ...status },
      ...(action.kind === "diff" ? { diff: await repo.diff() } : {}),
    };
  } catch (error) {
    if (error instanceof git.Errors.MergeConflictError)
      throw new Error(
        `Pull has conflicts in: ${error.data.filepaths.join(", ")}. Your working tree is unchanged. Resolve the merge on ${host}, then pull again.`,
      );
    if (error instanceof git.Errors.PushRejectedError)
      throw new Error(
        "Push rejected because the remote branch changed. Pull before pushing again.",
      );
    throw error;
  }
}

// Snapshots of the version history that Git replaced. Nothing writes them now.
export function collectLegacyHistory(bucket: SourceBucket) {
  return deletePrefix(bucket, "history/");
}

// Long enough for any saved clone whose transaction has yet to commit.
const unreferencedMs = 60 * 60_000;

export async function collectGitObjects({
  db,
  bucket,
  uploadedBefore = new Date(Date.now() - unreferencedMs),
}: {
  db: Db;
  bucket: SourceBucket;
  uploadedBefore?: Date;
}) {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: "git/", cursor, limit: 1000 });
    const objects = page.objects.flatMap(({ key, uploaded }) => {
      const id = /^git\/([0-9a-f-]{36})\//.exec(key)?.[1];
      return id && uploaded <= uploadedBefore ? [{ id, key }] : [];
    });
    // Every save has a new key, so one that nothing refers to by now never will
    // be, and no lock is needed. A project in the trash keeps its clone, so it can
    // be restored.
    const kept = new Set(
      objects.length
        ? (
            await db
              .select({ objectKey: projectGit.objectKey })
              .from(projectGit)
              .where(
                inArray(projectGit.projectId, [
                  ...new Set(objects.map(({ id }) => id)),
                ]),
              )
          ).map((linked) => linked.objectKey)
        : [],
    );
    const garbage = objects.filter(({ key }) => !kept.has(key));
    if (garbage.length) await bucket.delete(garbage.map(({ key }) => key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}
