import { createDb, type Db } from "@texfolia/db";
import {
  project,
  projectCollaboration,
  projectNode,
} from "@texfolia/db/schema";
import { DurableObject } from "cloudflare:workers";
import { and, eq, isNull } from "drizzle-orm";
import * as Y from "yjs";
import { z } from "zod";

import { DutyAlarm } from "#/lib/duty-alarm";
import { formatChanges } from "#/lib/editor/latex/format";
import { mapLimit } from "#/lib/map-limit";
import { liveAccessMs } from "#/lib/projects/live-access-interval";
import type {
  ProjectAccessRequest,
  ProjectTransaction,
} from "#/lib/projects/server";
import { decodeSource, type saveSourceSchema } from "#/lib/storage";
import { deletePrefix, prepareSourceBytes } from "#/lib/storage/server";

import {
  awarenessFrame,
  decodeClientMessage,
  documentIdSchema,
  encodeServerMessage,
  maxNameLength,
  outdatedClientMessage,
  readAwareness,
  scratchpadId,
  type ServerMessage,
} from "./protocol";
import {
  collaborationAccess,
  persistMergedSource,
  scratchpadAccess,
  sourceNode,
  type CollaborationLock,
  type SourceNode,
} from "./sources";
import {
  initializeChunks,
  readSnapshot,
  writeSnapshot,
  appendUpdate,
  readUpdates,
  deleteUpdates,
} from "./storage";
import { checkUpdate, measureUsage, type Usage } from "./usage";

// Stored with each socket, which Durable Objects limit to 2 KiB.
const attachmentSchema = z.object({
  projectId: z.uuid(),
  nodeId: documentIdSchema,
  userId: z.string(),
  name: z.string().transform((name) => name.slice(0, maxNameLength)),
  clientId: z.number().int().nonnegative(),
  // The cursor is JSON, or null when the tab shows none.
  awareness: z
    .object({
      clock: z.number(),
      cursor: z.string().nullable(),
      at: z.number(),
    })
    .nullable(),
  // False for tabs still on the base64 JSON protocol, which only get told to reload.
  binary: z.boolean().default(false),
  // Whether the tab understands `people` messages.
  people: z.boolean().default(false),
});
type Attachment = z.infer<typeof attachmentSchema>;
type DocumentInfo = Pick<Attachment, "nodeId" | "projectId">;
type DocumentRow = {
  node_id: string;
  project_id: string;
  object_key: string | null;
  dirty: number;
  updated_at: number;
};
// A node read from Postgres, and the document's version before the read. It is
// only worth applying while the document is still at that version.
type ReadNode = { source: SourceNode; seen: number };
const colors = [
  "#2563eb",
  "#9333ea",
  "#dc2626",
  "#059669",
  "#d97706",
  "#0891b2",
];
// A browser closing without a code is reported as one that cannot be sent back,
// and the closing handshake must be answered for its socket to close.
function closeCode(code: number) {
  return [1005, 1006, 1015].includes(code) ? 1000 : code;
}

// Messages about who else is in the project.
function isPresence(message: ServerMessage) {
  return message.type === "awareness" || message.type === "people";
}

const saveDelayMs = 2000;
const saveRetryMs = 5000;
const maxSaveRetryMs = 5 * 60_000;
// Each save holds a database connection while it uploads. A Worker may have six
// connections open, so this many can never wait for each other's uploads.
const saveConcurrency = 3;
// Checks finish before verified access expires, so deliveries rarely wait for one.
const accessCheckMs = liveAccessMs - 10_000;
// How long an open but unused document stays in memory.
const idleDocumentMs = 5 * 60_000;
// The queue for messages that no document owns.
const peopleQueue = "people";
const ignore = () => {};

// Changes the document's text with minimal edits.
function replaceText(doc: Y.Doc, value: string) {
  const text = doc.getText("source");
  doc.transact(() => {
    for (const change of formatChanges(text.toString(), value).reverse()) {
      text.delete(change.from, change.to - change.from);
      text.insert(change.from, change.insert);
    }
  });
}

async function hashText(value: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

// The bindings every room reads. Apps extend this with their own.
export type CollaborationEnv = {
  HYPERDRIVE: { connectionString: string };
  SOURCES: R2Bucket;
};

type Saved = { objectKey: string; updatedAt: number; value: string };

// The Yjs room for one project: a Durable Object that syncs, persists, and
// flushes collaborative sources. Apps subclass it to supply what collaboration
// does not own: project access, which principals are anonymous, and what to do
// after sources change. The subclass is the class Wrangler binds.
//
// Work on one document runs in that document's queue, so documents never wait for
// each other. Saving a document and checking access happen outside the queues:
// only loading a document, and delivering to someone whose access is unknown,
// wait for a database inside one.
export abstract class CollaborationRoom<
  E extends CollaborationEnv = CollaborationEnv,
> extends DurableObject<E> {
  // Locks the project and checks access. Runs inside a Postgres transaction.
  protected abstract lockProject(
    request: ProjectAccessRequest,
  ): ReturnType<CollaborationLock>;
  // The same check for several people at once, leaving out those it denies.
  protected abstract lockReaders(request: {
    tx: ProjectTransaction;
    projectId: string;
    userIds: readonly string[];
  }): Promise<Map<string, { canWrite: boolean }>>;
  // Anonymous principals, such as share-link viewers, have no presence.
  protected abstract isAnonymous(userId: string): boolean;
  // Runs after the room persists sources, for example to invalidate builds.
  protected abstract sourcesChanged(projectId: string): Promise<void>;

  private documents = new Map<string, Y.Doc>();
  private usedAt = new Map<string, number>();
  // Running text and history sizes, so edits are checked without re-encoding.
  private sizes = new WeakMap<Y.Doc, Usage>();
  private queues = new Map<string, Promise<void>>();
  // Set while an operation rewrites files, which holds off everything else.
  private paused: Promise<void> | null = null;
  private pauses: Promise<void> = Promise.resolve();
  // Saves in progress, one per document.
  private saving = new Map<string, Promise<void>>();
  private activeSaves = 0;
  private waitingSaves: (() => void)[] = [];
  private failedSaves = new Map<string, { count: number; retryAt: number }>();
  // Counts a document's accepted edits, so a save knows whether more arrived.
  private edits = new Map<string, number>();
  // Counts changes to the object a document is saved as.
  private versions = new Map<string, number>();
  // Verified access per user. Revocation paths clear it through invalidateAccess.
  // It expires, and the alarm closes the sockets of people who lost access.
  private access = new Map<string, { canWrite: boolean; at: number }>();
  private accessGeneration = 0;
  private verification: Promise<void> = Promise.resolve();
  private alarms: DutyAlarm<"save" | "access">;

  constructor(ctx: DurableObjectState, env: E) {
    super(ctx, env);
    const { sql } = ctx.storage;
    sql.exec(`CREATE TABLE IF NOT EXISTS documents (
      node_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, snapshot BLOB NOT NULL,
      object_key TEXT, dirty INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT, node_id TEXT NOT NULL, data BLOB NOT NULL, bytes INTEGER NOT NULL)`);
    // Objects that unfinished saves may have made the saved version.
    sql.exec(
      "CREATE TABLE IF NOT EXISTS saves (node_id TEXT, object_key TEXT, PRIMARY KEY (node_id, object_key))",
    );
    initializeChunks(sql);
    sql.exec(
      "CREATE INDEX IF NOT EXISTS updates_by_node ON updates (node_id, id)",
    );
    this.alarms = new DutyAlarm(ctx.storage);
    ctx.blockConcurrencyWhile(async () => {
      if ((await ctx.storage.getAlarm()) !== null) return;
      const now = Date.now();
      if (this.dirtyDocuments().length)
        await this.alarms.planBy("save", now + saveDelayMs);
      if (ctx.getWebSockets().length)
        await this.alarms.planBy("access", now + saveDelayMs);
      await this.alarms.setNext();
    });
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }

  // Runs operations with the same key one at a time.
  private enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(key) ?? Promise.resolve()).then(operation);
    const tail = next.then(ignore, ignore);
    this.queues.set(key, tail);
    void tail.then(() => {
      if (this.queues.get(key) !== tail) return;
      this.queues.delete(key);
      this.release(key);
    });
    return next;
  }

  // Runs an operation in a document's queue. Operations that started in order run
  // in order. Nothing inside a queue may wait for this, or for `save`.
  private async edit<T>(
    nodeId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    while (this.paused) await this.paused;
    return this.enqueue(nodeId, operation);
  }

  // Runs an operation while no document can change, after what already started.
  private pause<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pauses.then(async () => {
      const gate = Promise.withResolvers<void>();
      this.paused = gate.promise;
      try {
        while (this.queues.size || this.saving.size)
          await Promise.all([...this.queues.values(), ...this.saving.values()]);
        return await operation();
      } finally {
        this.paused = null;
        gate.resolve();
      }
    });
    this.pauses = next.then(ignore, ignore);
    return next;
  }

  private async withDb<T>(operation: (db: Db) => Promise<T>) {
    const db = createDb(this.env.HYPERDRIVE.connectionString);
    try {
      return await operation(db);
    } finally {
      await db.$client.end();
    }
  }

  private row(nodeId: string): DocumentRow | undefined {
    return this.ctx.storage.sql
      .exec<DocumentRow>(
        "SELECT node_id, project_id, object_key, dirty, updated_at FROM documents WHERE node_id = ?",
        nodeId,
      )
      .toArray()[0];
  }

  private dirtyDocuments() {
    return this.ctx.storage.sql
      .exec<Pick<DocumentRow, "node_id" | "project_id">>(
        "SELECT node_id, project_id FROM documents WHERE dirty <> 0",
      )
      .toArray();
  }

  private openSockets(nodeId?: string) {
    return this.ctx
      .getWebSockets(nodeId)
      .filter((ws) => ws.readyState === WebSocket.OPEN);
  }

  private info(ws: WebSocket) {
    return attachmentSchema.parse(ws.deserializeAttachment());
  }

  private version(nodeId: string) {
    return this.versions.get(nodeId) ?? 0;
  }

  private changed(nodeId: string) {
    this.versions.set(nodeId, this.version(nodeId) + 1);
  }

  // Drops a document from memory. Storage has all of it.
  private unload(nodeId: string) {
    this.documents.get(nodeId)?.destroy();
    this.documents.delete(nodeId);
    this.usedAt.delete(nodeId);
  }

  // Whether nothing in progress needs the document in memory.
  private settled(nodeId: string) {
    return (
      !this.queues.has(nodeId) &&
      !this.saving.has(nodeId) &&
      !this.row(nodeId)?.dirty
    );
  }

  // Runs when a document has no more work. Nobody is looking at it without a socket.
  private release(nodeId: string) {
    if (
      this.documents.has(nodeId) &&
      this.settled(nodeId) &&
      !this.openSockets(nodeId).length
    )
      this.unload(nodeId);
  }

  private releaseIdle() {
    const before = Date.now() - idleDocumentMs;
    for (const nodeId of this.documents.keys())
      if ((this.usedAt.get(nodeId) ?? 0) < before && this.settled(nodeId))
        this.unload(nodeId);
  }

  private removeDocument(nodeId: string) {
    this.unload(nodeId);
    this.changed(nodeId);
    this.edits.delete(nodeId);
    this.failedSaves.delete(nodeId);
    // Even when storage fails, nobody goes on editing a deleted file.
    for (const ws of this.openSockets(nodeId)) ws.close(1008, "File removed");
    this.ctx.storage.transactionSync(() => {
      const { sql } = this.ctx.storage;
      deleteUpdates(sql, nodeId);
      sql.exec("DELETE FROM snapshot_chunks WHERE node_id = ?", nodeId);
      sql.exec("DELETE FROM saves WHERE node_id = ?", nodeId);
      sql.exec("DELETE FROM documents WHERE node_id = ?", nodeId);
    });
  }

  // Every document this room stores or has open.
  private knownDocuments() {
    return new Set([
      ...this.ctx.storage.sql
        .exec<Pick<DocumentRow, "node_id">>("SELECT node_id FROM documents")
        .toArray()
        .map((row) => row.node_id),
      ...this.ctx.getWebSockets().map((ws) => this.info(ws).nodeId),
    ]);
  }

  // The project's text files. A project in the trash keeps its documents, whose
  // CRDT identities comments and offline edits depend on. Its sockets close when
  // access is verified.
  private async readNodes(db: Db, projectId: string) {
    const known = this.knownDocuments();
    const seen = new Map([...known].map((id) => [id, this.version(id)]));
    const rows = await db
      .select({
        id: projectNode.id,
        objectKey: projectNode.objectKey,
        updatedAt: projectNode.updatedAt,
        cleanupRequestedAt: projectCollaboration.cleanupRequestedAt,
      })
      .from(project)
      .leftJoin(
        projectNode,
        and(
          eq(project.id, projectNode.projectId),
          isNull(projectNode.deletedAt),
          eq(projectNode.kind, "text"),
        ),
      )
      .leftJoin(
        projectCollaboration,
        eq(projectCollaboration.projectId, project.id),
      )
      .where(eq(project.id, projectId));
    const nodes = new Map<string, ReadNode>();
    for (const { id, objectKey, updatedAt } of rows)
      if (id && updatedAt)
        nodes.set(id, {
          source: { objectKey, updatedAt },
          seen: seen.get(id) ?? 0,
        });
    return {
      projectDeleted: rows.length === 0,
      cleanupRequestedAt: rows[0]?.cleanupRequestedAt ?? null,
      // Files created since are left alone.
      removed: [...known].filter((id) =>
        id === scratchpadId ? rows.length === 0 : !nodes.has(id),
      ),
      nodes,
    };
  }

  // Removes the documents of deleted files.
  private async purge(
    projectId: string,
    read: Awaited<ReturnType<CollaborationRoom<E>["readNodes"]>>,
  ) {
    for (const nodeId of read.removed)
      await this.enqueue(nodeId, async () => this.removeDocument(nodeId));
    const { cleanupRequestedAt } = read;
    if (cleanupRequestedAt)
      await this.withDb((db) =>
        db
          .update(projectCollaboration)
          .set({ cleanupRequestedAt: null })
          .where(
            and(
              eq(projectCollaboration.projectId, projectId),
              eq(projectCollaboration.cleanupRequestedAt, cleanupRequestedAt),
            ),
          ),
      );
  }

  // Brings documents that are open, or in memory, up to date with sources written
  // outside collaboration. The others are when they load.
  private async reconcile(projectId: string, nodes: Map<string, ReadNode>) {
    const open = new Set([
      ...this.documents.keys(),
      ...this.openSockets().map((ws) => this.info(ws).nodeId),
    ]);
    for (const nodeId of open) {
      const node = nodes.get(nodeId);
      const row = node && this.row(nodeId);
      if (row && !row.dirty && row.object_key !== node.source.objectKey)
        await this.enqueue(nodeId, () =>
          this.document({ nodeId, projectId }, node),
        );
    }
  }

  async purgeDeletedSources(projectId: string) {
    const read = await this.withDb((db) => this.readNodes(db, projectId));
    await this.purge(projectId, read);
    if (read.projectDeleted)
      await deletePrefix(this.env.SOURCES, `git/${projectId}/`);
    return { projectDeleted: read.projectDeleted };
  }

  // Loads a document's stored snapshot and updates.
  private load(nodeId: string) {
    const { sql } = this.ctx.storage;
    const { snapshot } = sql
      .exec<{ snapshot: ArrayBuffer }>(
        "SELECT snapshot FROM documents WHERE node_id = ?",
        nodeId,
      )
      .one();
    const doc = new Y.Doc();
    Y.applyUpdate(doc, readSnapshot(sql, nodeId, snapshot));
    for (const update of readUpdates(sql, nodeId)) Y.applyUpdate(doc, update);
    return this.keep(nodeId, doc);
  }

  private keep(nodeId: string, doc: Y.Doc) {
    this.documents.set(nodeId, doc);
    this.usedAt.set(nodeId, Date.now());
    return doc;
  }

  private insertDocument(
    info: DocumentInfo,
    doc: Y.Doc,
    objectKey: string | null,
  ) {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "INSERT INTO documents (node_id, project_id, snapshot, object_key) VALUES (?, ?, ?, ?)",
        info.nodeId,
        info.projectId,
        new Uint8Array(),
        objectKey,
      );
      writeSnapshot(
        this.ctx.storage.sql,
        info.nodeId,
        Y.encodeStateAsUpdate(doc),
      );
    });
    this.changed(info.nodeId);
    return this.keep(info.nodeId, doc);
  }

  // The scratchpad lives only in this room's storage: it has no node, no source
  // object, and nothing to flush or reconcile.
  private scratchpad(projectId: string) {
    return this.row(scratchpadId)
      ? this.load(scratchpadId)
      : this.insertDocument(
          { nodeId: scratchpadId, projectId },
          new Y.Doc(),
          null,
        );
  }

  // Runs in the document's queue. Loading reconciles with Postgres; a document in
  // memory reconciles only when the caller already read its node, so edits do not
  // query the database.
  private async document(info: DocumentInfo, read?: ReadNode) {
    const { nodeId, projectId } = info;
    // Nothing changes the version while this runs, but something may have since
    // the node was read.
    const node = read?.seen === this.version(nodeId) ? read.source : undefined;
    const cached = this.documents.get(nodeId);
    if (cached) {
      this.usedAt.set(nodeId, Date.now());
      if (node) await this.reconcileSource(info, cached, node);
      return cached;
    }
    if (nodeId === scratchpadId) return this.scratchpad(projectId);
    const source =
      node ?? (await this.withDb((db) => sourceNode(db, projectId, nodeId)));
    const row = this.row(nodeId);
    if (!row) {
      const object = source.objectKey
        ? await this.env.SOURCES.get(source.objectKey)
        : null;
      if (source.objectKey && !object)
        throw new Error("Saved source is missing from storage");
      const doc = new Y.Doc();
      doc.getText("source").insert(0, object ? await object.text() : "");
      return this.insertDocument(info, doc, source.objectKey);
    }
    const doc = this.load(nodeId);
    try {
      if (row.dirty && source.objectKey !== row.object_key)
        await this.recover(row, doc, source);
      await this.reconcileSource(info, doc, source);
    } catch (error) {
      this.unload(nodeId);
      throw error;
    }
    return doc;
  }

  // Records a save that committed without this object hearing about it. A pending
  // save that never committed must stay editable, including after quota errors.
  private async recover(row: DocumentRow, doc: Y.Doc, node: SourceNode) {
    const hash = await hashText(doc.getText("source").toString());
    const current =
      node.objectKey === `projects/${row.project_id}/sources/${hash}`;
    if (!current && !this.unfinishedSaves(row.node_id).includes(node.objectKey))
      throw new Error(
        "Source changed outside collaboration. Reopen the project before saving.",
      );
    this.recordSave(row.node_id, {
      objectKey: node.objectKey,
      updatedAt: node.updatedAt.getTime(),
      clean: current,
      final: current,
    });
  }

  private unfinishedSaves(nodeId: string): (string | null)[] {
    return this.ctx.storage.sql
      .exec<{ object_key: string }>(
        "SELECT object_key FROM saves WHERE node_id = ?",
        nodeId,
      )
      .toArray()
      .map((row) => row.object_key);
  }

  private recordSave(
    nodeId: string,
    saved: {
      objectKey: string | null;
      updatedAt: number;
      clean: boolean;
      final: boolean;
    },
  ) {
    this.ctx.storage.transactionSync(() => {
      const { sql } = this.ctx.storage;
      sql.exec(
        "UPDATE documents SET object_key = ?, updated_at = ? WHERE node_id = ?",
        saved.objectKey,
        saved.updatedAt,
        nodeId,
      );
      if (saved.clean)
        sql.exec("UPDATE documents SET dirty = 0 WHERE node_id = ?", nodeId);
      // A version that replaced every other leaves none of them to commit.
      if (saved.final) sql.exec("DELETE FROM saves WHERE node_id = ?", nodeId);
      else
        sql.exec(
          "DELETE FROM saves WHERE node_id = ? AND object_key = ?",
          nodeId,
          saved.objectKey,
        );
    });
    this.changed(nodeId);
  }

  private user(info: Attachment) {
    let hash = 0;
    for (const character of info.userId)
      hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
    return {
      name: info.name,
      color: colors[hash % colors.length] ?? "#2563eb",
    };
  }

  // Records access read since `at`, unless an invalidation during the check may
  // have revoked it.
  private remember(
    readers: Iterable<[string, { canWrite: boolean }]>,
    { generation, at }: { generation: number; at: number },
  ) {
    if (generation !== this.accessGeneration) return;
    for (const [userId, { canWrite }] of readers)
      this.access.set(userId, { canWrite, at });
  }

  private verified(userId: string) {
    const access = this.access.get(userId);
    return access && Date.now() - access.at < liveAccessMs ? access : undefined;
  }

  private disconnect(userIds: ReadonlySet<string>) {
    for (const userId of userIds) this.access.delete(userId);
    for (const ws of this.openSockets())
      if (userIds.has(this.info(ws).userId))
        ws.close(1008, "Project access could not be verified");
  }

  // Checks these users in one transaction, and disconnects everyone who may not
  // read the project. Failure to verify access must never leave a recipient
  // subscribed, so it disconnects them all.
  private async checkAccess(projectId: string, userIds: readonly string[]) {
    const started = { generation: this.accessGeneration, at: Date.now() };
    let readers = new Map<string, { canWrite: boolean }>();
    try {
      readers = await this.withDb((db) =>
        db.transaction((tx) => this.lockReaders({ tx, projectId, userIds })),
      );
    } catch (error) {
      console.error("Collaboration access check failed", { projectId, error });
    }
    this.remember(readers, started);
    this.disconnect(new Set(userIds.filter((id) => !readers.has(id))));
  }

  // Afterward, each of these sockets belongs to a verified user or is closed.
  // Checks take turns, so one covers everyone who waited for it.
  private async verify(sockets: readonly WebSocket[]) {
    const unverified = () => {
      const users = new Map<string, string>();
      for (const ws of sockets) {
        if (ws.readyState !== WebSocket.OPEN) continue;
        const { userId, projectId } = this.info(ws);
        if (!this.verified(userId)) users.set(userId, projectId);
      }
      return users;
    };
    while (unverified().size) {
      const check = this.verification.then(async () => {
        const users = unverified();
        const [projectId] = users.values();
        if (projectId) await this.checkAccess(projectId, [...users.keys()]);
      });
      this.verification = check.catch(ignore);
      await check;
    }
  }

  // Revocation paths call this, possibly inside the revoking transaction, so it
  // must not wait on Postgres. Later deliveries re-verify behind the revocation's
  // locks, and the alarm closes revoked sockets that receive nothing.
  async invalidateAccess(userIds?: string[]) {
    this.accessGeneration++;
    if (userIds) for (const userId of userIds) this.access.delete(userId);
    else this.access.clear();
    // An alarm running now forgets duties planned until it started.
    if (this.openSockets().length)
      await this.alarms.plan("access", Date.now() + 1);
  }

  // Verifies everyone connected, which closes sockets of people whose revocation
  // this room missed, and catches up with files changed or deleted elsewhere.
  private async checkProject() {
    this.releaseIdle();
    const users = new Set<string>();
    let projectId: string | undefined;
    for (const ws of this.openSockets()) {
      const info = this.info(ws);
      ({ projectId } = info);
      users.add(info.userId);
    }
    if (!projectId) return;
    await this.checkAccess(projectId, [...users]);
    if (!this.openSockets().length) return;
    const project = projectId;
    const read = await this.withDb((db) => this.readNodes(db, project));
    await this.purge(project, read);
    await this.reconcile(project, read.nodes);
  }

  private receives(ws: WebSocket, presence: boolean, binary: boolean) {
    if (ws.readyState !== WebSocket.OPEN) return false;
    const info = this.info(ws);
    // Outdated tabs cannot read binary frames, and anonymous share-link viewers
    // never see who else is in the project.
    return (
      (info.binary || !binary) && !(presence && this.isAnonymous(info.userId))
    );
  }

  private async deliver(sockets: readonly WebSocket[], message: ServerMessage) {
    // Encode once for every peer.
    const frame = encodeServerMessage(message);
    const recipients = sockets.filter((ws) =>
      this.receives(ws, isPresence(message), typeof frame !== "string"),
    );
    await this.verify(recipients);
    for (const ws of recipients)
      if (ws.readyState === WebSocket.OPEN) ws.send(frame);
  }

  private send(ws: WebSocket, message: ServerMessage) {
    return this.deliver([ws], message);
  }

  private broadcast(
    nodeId: string,
    message: ServerMessage,
    except?: WebSocket,
  ) {
    return this.deliver(
      this.openSockets(nodeId).filter((ws) => ws !== except),
      message,
    );
  }

  // Signed-in users with an open file, leaving out the `closing` socket.
  private present(closing?: WebSocket) {
    const users = new Map<string, Attachment>();
    for (const ws of this.openSockets()) {
      if (ws === closing) continue;
      const info = this.info(ws);
      if (info.binary && !this.isAnonymous(info.userId))
        users.set(info.userId, info);
    }
    return users;
  }

  private people(closing?: WebSocket): ServerMessage {
    return {
      type: "people",
      people: [...this.present(closing).values()].map((info) =>
        this.user(info),
      ),
    };
  }

  // Tells every tab who is in the project. Tabs only connect to open files, so
  // awareness alone would miss people working in other files. Lists are sent in
  // the order they were made.
  private broadcastPeople(except: WebSocket, closing?: WebSocket) {
    this.ctx.waitUntil(
      this.enqueue(peopleQueue, () =>
        this.deliver(
          this.openSockets().filter(
            (ws) => ws !== except && this.info(ws).people,
          ),
          this.people(closing),
        ),
      ).catch((error: unknown) =>
        console.error("Collaboration presence failed", { error }),
      ),
    );
  }

  override async fetch(request: Request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return new Response("WebSocket required", { status: 426 });
    const info = attachmentSchema.parse(
      JSON.parse(request.headers.get("X-Collaboration-Session") ?? "null"),
    );
    const { nodeId, projectId, userId } = info;
    const started = { generation: this.accessGeneration, at: Date.now() };
    const seen = this.version(nodeId);
    const access = {
      register: true,
      lock: (request: ProjectAccessRequest) => this.lockProject(request),
    };
    const { node, canWrite } = await this.withDb(async (db) =>
      nodeId === scratchpadId
        ? {
            node: undefined,
            ...(await scratchpadAccess(db, projectId, userId, access)),
          }
        : collaborationAccess(db, projectId, nodeId, userId, access),
    );
    return this.edit(nodeId, async () => {
      if (info.binary)
        await this.document(info, node && { source: node, seen });
      this.remember([[userId, { canWrite }]], started);
      // Access may have been revoked since the check.
      if (!this.verified(userId)) await this.checkAccess(projectId, [userId]);
      if (!this.verified(userId))
        return new Response("File not found", { status: 404 });
      const joined =
        info.binary && !this.isAnonymous(userId) && !this.present().has(userId);
      const pair = new WebSocketPair();
      pair[1].serializeAttachment(info);
      this.ctx.acceptWebSocket(pair[1], [nodeId]);
      // The new socket asks for the list itself, when it synchronizes.
      if (joined) this.broadcastPeople(pair[1]);
      await this.alarms.planBy("access", Date.now() + accessCheckMs);
      return new Response(null, { status: 101, webSocket: pair[0] });
    });
  }

  // Runs in the document's queue.
  private async apply(info: DocumentInfo, bytes: Uint8Array) {
    const { nodeId } = info;
    const doc = await this.document(info);
    // Sources are dirty until saved; the scratchpad's storage is this room.
    const saves = nodeId !== scratchpadId;
    const usage = checkUpdate(
      doc,
      this.sizes.get(doc) ?? measureUsage(doc),
      bytes,
    );
    Y.applyUpdate(doc, bytes);
    this.sizes.set(doc, usage);
    this.edits.set(nodeId, (this.edits.get(nodeId) ?? 0) + 1);
    try {
      this.ctx.storage.transactionSync(() => {
        appendUpdate(this.ctx.storage.sql, nodeId, bytes);
        if (saves)
          this.ctx.storage.sql.exec(
            "UPDATE documents SET dirty = 1 WHERE node_id = ?",
            nodeId,
          );
        const stored = this.ctx.storage.sql
          .exec<{ count: number; bytes: number }>(
            "SELECT count(*) AS count, coalesce(sum(bytes), 0) AS bytes FROM updates WHERE node_id = ?",
            nodeId,
          )
          .one();
        if (stored.count >= 64 || stored.bytes >= 256 * 1024) {
          const snapshot = Y.encodeStateAsUpdate(doc);
          writeSnapshot(this.ctx.storage.sql, nodeId, snapshot);
          deleteUpdates(this.ctx.storage.sql, nodeId);
          usage.historyBytes = snapshot.byteLength;
        }
      });
    } catch (error) {
      // Reload from storage so the room never holds an unpersisted update.
      this.unload(nodeId);
      throw error;
    }
    if (saves)
      await this.alarms.planBy(
        "save",
        Math.max(
          Date.now() + saveDelayMs,
          this.failedSaves.get(nodeId)?.retryAt ?? 0,
        ),
      );
    await this.broadcast(nodeId, { type: "update", update: bytes });
  }

  override async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ) {
    const info = this.info(ws);
    const saveId = await this.edit(info.nodeId, () =>
      this.receive(ws, message),
    );
    if (!saveId) return;
    // Saving must not hold up the document's edits.
    try {
      const saved = await this.save(info.nodeId);
      if (!saved) throw new Error("File not found");
      await this.send(ws, { type: "saved", id: saveId, ...saved });
    } catch (error) {
      await this.reportError(ws, error, saveId);
    }
  }

  private reportError(ws: WebSocket, error: unknown, id?: string) {
    return this.send(ws, {
      type: "error",
      message: error instanceof Error ? error.message : "Collaboration failed",
      ...(id ? { id } : {}),
    });
  }

  // Handles a message in its document's queue, and returns the ID of a save
  // request, which the caller finishes outside it.
  private async receive(ws: WebSocket, message: string | ArrayBuffer) {
    if (ws.readyState !== WebSocket.OPEN) return undefined;
    let requestId: string | undefined;
    try {
      const info = this.info(ws);
      const { nodeId } = info;
      if (!info.binary) {
        // The tab keeps its offline edits and merges them after reloading.
        await this.send(ws, { type: "error", message: outdatedClientMessage });
        return undefined;
      }
      const data = decodeClientMessage(message);
      if (data.type === "save") requestId = data.id;
      await this.verify([ws]);
      const access = this.verified(info.userId);
      if (!access) throw new Error("Project not found");
      const doc = await this.document(info);
      switch (data.type) {
        case "sync": {
          const row = this.row(nodeId);
          await this.send(ws, {
            type: "sync",
            update: Y.encodeStateAsUpdate(doc, data.vector),
            vector: Y.encodeStateVector(doc),
            dirty: Boolean(row?.dirty),
            objectKey: row?.object_key ?? null,
            canWrite: access.canWrite,
            user: this.user(info),
          });
          if (info.people) await this.send(ws, this.people());
          for (const peer of this.openSockets(nodeId)) {
            if (peer === ws) continue;
            const other = this.info(peer);
            if (other.awareness && Date.now() - other.awareness.at < 30_000)
              await this.send(ws, this.presence(other));
          }
          break;
        }
        case "update":
          if (!access.canWrite)
            throw new Error("Viewers cannot edit documents");
          await this.apply(info, data.update);
          break;
        case "save":
          if (!access.canWrite)
            throw new Error("Viewers cannot edit documents");
          if (nodeId !== scratchpadId) return data.id;
          // Accepted scratchpad edits are already stored.
          await this.send(ws, {
            type: "saved",
            id: data.id,
            value: doc.getText("source").toString(),
            objectKey: null,
            updatedAt: Date.now(),
          });
          break;
        case "awareness": {
          // Share-link viewers are not shown to collaborators.
          if (this.isAnonymous(info.userId)) break;
          const { clock, cursor } = readAwareness(data.update, info.clientId);
          if (info.awareness && clock < info.awareness.clock) break;
          info.awareness = { clock, cursor, at: Date.now() };
          ws.serializeAttachment(info);
          await this.broadcast(nodeId, this.presence(info), ws);
          break;
        }
      }
    } catch (error) {
      await this.reportError(ws, error, requestId);
    }
    return undefined;
  }

  private presence(info: Attachment): ServerMessage {
    const { clock, cursor } = info.awareness ?? { clock: 0, cursor: null };
    return {
      type: "awareness",
      update: awarenessFrame(
        info.clientId,
        clock,
        cursor === null
          ? null
          : { cursor: JSON.parse(cursor) as unknown, user: this.user(info) },
      ),
    };
  }

  // Saves a document's current text. Returns null when the file is gone.
  private async save(nodeId: string) {
    while (this.paused) await this.paused;
    return this.saveNow(nodeId);
  }

  // Saves of one document take turns, outside its queue.
  private async saveNow(nodeId: string): Promise<Saved | null> {
    const next = (this.saving.get(nodeId) ?? Promise.resolve()).then(() =>
      this.persist(nodeId),
    );
    const settled = next.then(ignore, ignore);
    this.saving.set(nodeId, settled);
    void settled.then(() => {
      if (this.saving.get(nodeId) !== settled) return;
      this.saving.delete(nodeId);
      this.release(nodeId);
    });
    const result = await next;
    if (!result) return null;
    await this.sourcesChanged(result.projectId);
    return result.saved;
  }

  private async limitSaves<T>(operation: () => Promise<T>) {
    if (this.activeSaves >= saveConcurrency)
      await new Promise<void>((resolve) => this.waitingSaves.push(resolve));
    else this.activeSaves++;
    try {
      return await operation();
    } finally {
      // Hand the place to the next in line, if any.
      const next = this.waitingSaves.shift();
      if (next) next();
      else this.activeSaves--;
    }
  }

  private async persist(nodeId: string) {
    const pending = await this.enqueue(nodeId, async () => {
      const row = this.row(nodeId);
      if (!row) return null;
      const doc = this.documents.get(nodeId) ?? this.load(nodeId);
      const value = doc.getText("source").toString();
      const edits = this.edits.get(nodeId) ?? 0;
      const upload = await prepareSourceBytes(
        row.project_id,
        new TextEncoder().encode(value),
      );
      const expectedObjectKeys = [
        row.object_key,
        ...this.unfinishedSaves(nodeId),
      ];
      // Once this commits, a lost answer must not look like a foreign change.
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO saves VALUES (?, ?)",
        nodeId,
        upload.objectKey,
      );
      return {
        projectId: row.project_id,
        value,
        edits,
        upload,
        expectedObjectKeys,
      };
    });
    if (!pending) return null;
    const { projectId, value, edits, upload, expectedObjectKeys } = pending;
    let version;
    try {
      version = await this.limitSaves(() =>
        this.withDb((db) =>
          persistMergedSource({
            db,
            bucket: this.env.SOURCES,
            projectId,
            nodeId,
            expectedObjectKeys,
            upload,
          }),
        ),
      );
    } catch (error) {
      // Loading again finds out whether the save committed.
      await this.enqueue(nodeId, async () => this.unload(nodeId));
      throw error;
    }
    const saved = await this.enqueue(nodeId, async () => {
      if (!version) {
        this.removeDocument(nodeId);
        return null;
      }
      // Otherwise the document was removed meanwhile.
      if (this.unfinishedSaves(nodeId).includes(upload.objectKey)) {
        const clean = (this.edits.get(nodeId) ?? 0) === edits;
        this.recordSave(nodeId, { ...version, clean, final: true });
        this.failedSaves.delete(nodeId);
        if (!clean) await this.alarms.planBy("save", Date.now() + saveDelayMs);
      }
      return { ...version, value };
    });
    return saved && { projectId, saved };
  }

  private async saveDirty() {
    const due = this.dirtyDocuments().filter(
      ({ node_id }) =>
        (this.failedSaves.get(node_id)?.retryAt ?? 0) <= Date.now(),
    );
    await mapLimit(due, saveConcurrency, async (row) => {
      const nodeId = row.node_id;
      try {
        await this.save(nodeId);
      } catch (error) {
        console.error("Collaborative source flush failed", {
          projectId: row.project_id,
          nodeId,
          error,
        });
        const count = (this.failedSaves.get(nodeId)?.count ?? 0) + 1;
        this.failedSaves.set(nodeId, {
          count,
          retryAt:
            Date.now() +
            Math.min(saveRetryMs * 2 ** (count - 1), maxSaveRetryMs),
        });
        await this.enqueue(nodeId, () =>
          this.broadcast(nodeId, {
            type: "error",
            message:
              "Edits are retained in collaboration, but source saving failed. " +
              (error instanceof Error ? error.message : "Retrying."),
          }),
        );
      }
    });
  }

  override async alarm() {
    const now = Date.now();
    const { alarms } = this;
    const run = async (
      duty: "save" | "access",
      work: () => Promise<void>,
      next: () => number | null,
    ) => {
      if (!alarms.due(duty, now)) return;
      try {
        await work();
      } finally {
        alarms.done(duty, now);
        const at = next();
        if (at !== null) await alarms.planBy(duty, at);
      }
    };
    const results = await Promise.allSettled([
      run(
        "save",
        () => this.saveDirty(),
        () => {
          const dirty = this.dirtyDocuments();
          return dirty.length
            ? Math.min(
                ...dirty.map(({ node_id }) =>
                  Math.max(
                    Date.now() + saveDelayMs,
                    this.failedSaves.get(node_id)?.retryAt ?? 0,
                  ),
                ),
              )
            : null;
        },
      ),
      run(
        "access",
        () => this.checkProject(),
        () => (this.openSockets().length ? Date.now() + accessCheckMs : null),
      ),
    ]);
    await alarms.setNext();
    for (const result of results)
      if (result.status === "rejected")
        console.error("Collaboration alarm failed", { error: result.reason });
  }

  async saveSource(options: {
    data: z.infer<typeof saveSourceSchema>;
    userId: string;
    name?: string;
  }) {
    const { data, userId } = options;
    const { projectId, nodeId } = data;
    const info = { projectId, nodeId };
    // Access may be revoked between the check and the document's turn.
    for (let applied = false; !applied;) {
      const generation = this.accessGeneration;
      const seen = this.version(nodeId);
      const { node, canWrite } = await this.withDb((db) =>
        collaborationAccess(db, projectId, nodeId, userId, {
          register: true,
          lock: (request) => this.lockProject(request),
        }),
      );
      if (!canWrite) throw new Error("Viewers cannot edit documents");
      applied = await this.edit(nodeId, async () => {
        if (generation !== this.accessGeneration) return false;
        const doc = await this.document(info, { source: node, seen });
        const row = this.row(nodeId);
        if (!row || row.dirty || row.object_key !== data.expectedObjectKey)
          throw new Error(
            "File changed on the server. Recover your draft in the collaborative editor.",
          );
        const value = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: false,
        }).decode(decodeSource(data.content));
        const candidate = new Y.Doc();
        Y.applyUpdate(candidate, Y.encodeStateAsUpdate(doc));
        replaceText(candidate, value);
        const update = Y.encodeStateAsUpdate(
          candidate,
          Y.encodeStateVector(doc),
        );
        candidate.destroy();
        await this.apply(info, update);
        return true;
      });
    }
    const saved = await this.save(nodeId);
    if (!saved) throw new Error("File not found");
    return { objectKey: saved.objectKey, updatedAt: saved.updatedAt };
  }

  // The scratchpad's text, for people with their own access to the project.
  async readScratchpad(options: { projectId: string; userId: string }) {
    await this.withDb((db) =>
      scratchpadAccess(db, options.projectId, options.userId, {
        lock: (request) => this.lockProject(request),
      }),
    );
    return this.edit(scratchpadId, async () =>
      // Reading a scratchpad nobody has opened must not create it.
      this.row(scratchpadId)
        ? (await this.document({ ...options, nodeId: scratchpadId }))
            .getText("source")
            .toString()
        : "",
    );
  }

  // Runs an operation that reads or rewrites a project's saved sources outside
  // collaboration, such as Git, after checking access and saving accepted edits.
  // The operation rewrites sources inside `exclusively`, which holds off edits,
  // saves the latest ones first, and brings open documents up to date afterward.
  protected async withSavedSources<T>(options: {
    projectId: string;
    userId: string;
    access: "read" | "write";
    run: (
      db: Db,
      exclusively: <R>(rewrite: () => Promise<R>) => Promise<R>,
    ) => Promise<T>;
  }) {
    const { projectId, userId, access } = options;
    const read = await this.withDb(async (db) => {
      await db.transaction((tx) =>
        this.lockProject({ tx, projectId, userId, access }),
      );
      return this.readNodes(db, projectId);
    });
    await this.purge(projectId, read);
    for (const { node_id } of this.dirtyDocuments()) await this.save(node_id);
    const exclusively = async <R>(rewrite: () => Promise<R>) => {
      const result = await this.pause(async () => {
        for (const { node_id } of this.dirtyDocuments())
          await this.saveNow(node_id);
        const result = await rewrite();
        const read = await this.withDb((db) => this.readNodes(db, projectId));
        await this.purge(projectId, read);
        await this.reconcile(projectId, read.nodes);
        return result;
      });
      await this.sourcesChanged(projectId);
      return result;
    };
    return this.withDb((db) => options.run(db, exclusively));
  }

  // Runs in the document's queue.
  private async reconcileSource(
    info: DocumentInfo,
    doc: Y.Doc,
    node: SourceNode,
  ) {
    const { nodeId } = info;
    const row = this.row(nodeId);
    // A save in progress records its own version.
    if (!row || row.dirty || this.saving.has(nodeId)) return;
    if (row.object_key === node.objectKey) return;
    const object = node.objectKey
      ? await this.env.SOURCES.get(node.objectKey)
      : null;
    if (node.objectKey && !object) throw new Error("Saved source is missing");
    const value = object ? await object.text() : "";
    const vector = Y.encodeStateVector(doc);
    replaceText(doc, value);
    const update = Y.encodeStateAsUpdate(doc, vector);
    this.sizes.delete(doc);
    this.ctx.storage.transactionSync(() => {
      writeSnapshot(this.ctx.storage.sql, nodeId, Y.encodeStateAsUpdate(doc));
      deleteUpdates(this.ctx.storage.sql, nodeId);
      this.ctx.storage.sql.exec(
        "UPDATE documents SET object_key = ?, updated_at = ? WHERE node_id = ?",
        node.objectKey,
        node.updatedAt.getTime(),
        nodeId,
      );
    });
    this.changed(nodeId);
    await this.broadcast(nodeId, { type: "update", update });
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string) {
    const info = this.info(ws);
    await this.edit(info.nodeId, async () => {
      if (info.binary) {
        const { awareness } = this.info(ws);
        const update = awarenessFrame(
          info.clientId,
          (awareness?.clock ?? 0) + 1,
          null,
        );
        await this.broadcast(info.nodeId, { type: "awareness", update }, ws);
        if (
          !this.isAnonymous(info.userId) &&
          !this.present(ws).has(info.userId)
        )
          this.broadcastPeople(ws, ws);
      }
      ws.close(closeCode(code), reason);
    });
  }

  override async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws, 1011, "Connection failed");
  }
}
