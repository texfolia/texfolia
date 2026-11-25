import type { Db } from "@texfolia/db";
import {
  account,
  member,
  projectCollaboration,
  projectGit,
  projectNode,
} from "@texfolia/db/schema";
import { and, eq, isNull, inArray } from "drizzle-orm";
import * as git from "isomorphic-git";

import { isOrgAdmin } from "#/lib/auth/roles";
import { ByteBudget } from "#/lib/map-limit";
import { projectPaths } from "#/lib/projects";
import type { LockProject, ProjectTransaction } from "#/lib/projects/server";
import { maxSourceFileBytes, maxSourceProjectBytes } from "#/lib/storage";
import {
  commitSources,
  deletePrefix,
  prepareSourceBytes,
  sourceBytesInFlight,
  sourceConcurrency,
  storeSource,
  type SourceBucket,
  type SourceUpload,
} from "#/lib/storage/server";

import { saveArchive } from "./archive";
import { gitProvider, gitProviders, hasRepositoryAccess } from "./providers";
import { replaceFiles, type GitNode, type StoredSource } from "./replace-files";
import { GitRepository, gitHttp, type GitFile } from "./repository";
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

class MissingObjectError extends Error {}

type ProjectFile = GitFile & { source: StoredSource };

function sourceHash(objectKey: string | null) {
  return objectKey?.slice(objectKey.lastIndexOf("/") + 1) ?? "";
}

// The project's files as a working tree, read from R2 one at a time and only
// when Git needs them. `blobs` names the Git blob of sources already hashed.
function projectFiles(
  bucket: Pick<SourceBucket, "get">,
  nodes: GitNode[],
  blobs: ReadonlyMap<string, string>,
) {
  const paths = projectPaths(nodes);
  const files = new Map<string, ProjectFile>();
  for (const { id, kind, objectKey, sizeBytes } of nodes) {
    const path = paths.get(id);
    if (!path || kind === "folder") continue;
    files.set(path, {
      oid: blobs.get(sourceHash(objectKey)),
      sizeBytes: Number(sizeBytes),
      source: { objectKey, sizeBytes, kind },
      async read() {
        if (!objectKey) return new Uint8Array();
        const object = await bucket.get(objectKey);
        if (!object)
          throw new MissingObjectError("Saved project source is missing.");
        return new Uint8Array(await object.arrayBuffer());
      },
    });
  }
  return files;
}

function sourceKind(bytes: Uint8Array) {
  if (bytes.includes(0)) return "binary";
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return "text";
  } catch {
    return "binary";
  }
}

const sourceLimitMessage =
  "Repository exceeds project source limits (10 MiB per file, 50 MiB total).";

// Finds or stores the content of every file in the working tree. Files and blobs
// that the project already has are not read, and objects that live nodes use are
// not stored again; `live` holds their keys.
async function storeFiles({
  bucket,
  projectId,
  repo,
  current,
  live,
}: {
  bucket: SourceBucket;
  projectId: string;
  repo: GitRepository;
  /** The project's files, whose blobs a clean working tree knows. */
  current: ReadonlyMap<string, ProjectFile>;
  live: ReadonlySet<string | null>;
}) {
  const sources = new Map<string, StoredSource>();
  for (const { oid, source } of current.values())
    if (oid) sources.set(oid, source);
  const uploads = new Map<string, SourceUpload>();
  const files = new Map<string, StoredSource>();
  const budget = new ByteBudget({
    limit: sourceConcurrency,
    maxBytes: sourceBytesInFlight,
  });
  const writes: Promise<void>[] = [];
  let failure: { error: unknown } | undefined;
  let total = 0;
  for (const [path, file] of repo.files) {
    if (failure) break;
    const { oid, read } = file;
    const kept = current.get(path);
    let source =
      kept === file ? kept.source : oid ? sources.get(oid) : undefined;
    if (!source) {
      // Inflating is sequential anyway; only the writes run side by side.
      const bytes = await read();
      if (bytes.byteLength > maxSourceFileBytes)
        throw new Error(sourceLimitMessage);
      const { objectKey, sizeBytes } = await prepareSourceBytes(
        projectId,
        bytes,
      );
      source = { objectKey, sizeBytes, kind: sourceKind(bytes) };
      if (!live.has(objectKey) && !uploads.has(objectKey)) {
        uploads.set(objectKey, {
          objectKey,
          sizeBytes,
          stored: true,
          bytes: read,
        });
        const release = await budget.acquire(bytes.byteLength);
        writes.push(
          storeSource(bucket, { objectKey, bytes })
            .catch((error: unknown) => {
              failure ??= { error };
            })
            .finally(release),
        );
      }
    }
    if (oid) sources.set(oid, source);
    total += Number(source.sizeBytes);
    if (total > maxSourceProjectBytes) throw new Error(sourceLimitMessage);
    files.set(path, source);
  }
  await Promise.all(writes);
  if (failure) throw failure.error;
  return { files, uploads: [...uploads.values()] };
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
const changedMessage =
  "The project changed while Git was syncing. Nothing was applied; try again.";

async function loadRepository(
  bucket: Pick<SourceBucket, "get">,
  objectKey: string,
) {
  const object = await bucket.get(objectKey);
  if (!object) throw new MissingObjectError("Saved git repository is missing.");
  return objectKey.endsWith(".json")
    ? GitRepository.restoreLegacy(await object.text())
    : GitRepository.restore(object.body);
}

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
        await tx.delete(projectGit).where(eq(projectGit.projectId, projectId));
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
  type Snapshot = NonNullable<Awaited<ReturnType<typeof readSnapshot>>>;
  const runSnapshot = async ({ linked, nodes }: Snapshot) => {
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
    const remote = connecting
      ? action.remote
      : linked?.url
        ? gitRemoteSchema.parse(linked.url)
        : null;
    if (remote) host = gitProvider(remote.provider).label;
    const repo = linked
      ? await loadRepository(bucket, linked.objectKey)
      : new GitRepository();
    const blobs = await repo.sourceBlobs();
    let worktree =
      action.kind === "import"
        ? new Map<string, ProjectFile>()
        : projectFiles(bucket, nodes, blobs);
    repo.overlay(worktree);
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
      const live = new Set(replaced?.map((node) => node.objectKey));
      const stored =
        replaced &&
        (await storeFiles({
          bucket,
          projectId,
          repo,
          current: worktree,
          live,
        }));
      repo.saveSourceBlobs(
        new Map(
          [...repo.files].flatMap(([path, { oid }]) => {
            const source = stored
              ? stored.files.get(path)
              : worktree.get(path)?.source;
            return oid && source?.objectKey
              ? [[sourceHash(source.objectKey), oid] as const]
              : [];
          }),
        ),
      );
      // Collection leaves recent clones alone until a row refers to them.
      const objectKey = `git/${projectId}/${crypto.randomUUID()}.bin`;
      await saveArchive(bucket, objectKey, repo.metadata());
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
        if (replaced && stored) {
          const latest = await readNodes(tx, projectId);
          if (nodeVersions(latest) !== nodeVersions(replaced))
            throw new Error(changedMessage);
          await replaceFiles(tx, projectId, latest, stored.files);
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
      // Files that live nodes already store stay stored until this commits.
      await commitSources({
        db,
        bucket,
        projectId,
        uploads: stored?.uploads ?? [],
        run,
      });
    };
    // Rewrites the project's files from the repository, as they are by now.
    const replace = (change: () => Promise<unknown>) =>
      exclusively(async () => {
        const latest = await readSnapshot();
        if (!latest || latest.linked?.objectKey !== linked?.objectKey)
          throw new Error(changedMessage);
        if (action.kind !== "import") {
          worktree = projectFiles(bucket, latest.nodes, blobs);
          repo.overlay(worktree);
        }
        await change();
        await save(latest.nodes);
      });
    if (action.kind === "link" && http && remote)
      await repo.requireEmptyRemote(remote.url, http);
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
  };
  try {
    // Short snapshot transaction: no R2 reads or Git host requests while the
    // project row is locked.
    const snapshot = await readSnapshot();
    if (!snapshot) return { status: empty };
    try {
      return await runSnapshot(snapshot);
    } catch (error) {
      if (!(error instanceof MissingObjectError)) throw error;
      // An object may have been retired and garbage-collected after the
      // snapshot lock was released. Re-check the DB before reporting corruption.
      const latest = await readSnapshot();
      const changed =
        latest?.linked?.objectKey !== snapshot.linked?.objectKey ||
        nodeVersions(latest?.nodes ?? []) !== nodeVersions(snapshot.nodes);
      if (!changed) throw error;
      if (!readOnly) throw new Error(changedMessage);
      return latest ? await runSnapshot(latest) : { status: empty };
    }
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
