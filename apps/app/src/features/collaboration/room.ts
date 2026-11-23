import { createDb, type Db } from "@texfolia/db";
import { project, projectNode } from "@texfolia/db/schema";
import { DurableObject } from "cloudflare:workers";
import { and, eq, isNull } from "drizzle-orm";
import * as Y from "yjs";
import { z } from "zod";

import { formatChanges } from "#/features/editor/latex/format";
import {
  liveProjectAccessIntervalMs,
  type ProjectAccessRequest,
} from "#/features/projects/server";
import { decodeSource, type saveSourceSchema } from "#/features/storage";

import {
  awarenessFrame,
  decodeClientMessage,
  encodeServerMessage,
  outdatedClientMessage,
  readAwareness,
  type ServerMessage,
} from "./protocol";
import {
  collaborationAccess,
  persistMergedSource,
  sourceNode,
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

const attachmentSchema = z.object({
  projectId: z.uuid(),
  nodeId: z.uuid(),
  userId: z.string(),
  name: z.string().max(200),
  clientId: z.number().int().nonnegative(),
  awareness: z
    .object({
      clock: z.number(),
      update: z.instanceof(Uint8Array),
      at: z.number(),
    })
    .nullable(),
  // False for tabs still on the base64 JSON protocol, which only get told to reload.
  binary: z.boolean().default(false),
  // Whether the tab understands `people` messages.
  people: z.boolean().default(false),
});
type Attachment = z.infer<typeof attachmentSchema>;
type DocumentRow = {
  node_id: string;
  project_id: string;
  snapshot: ArrayBuffer;
  object_key: string | null;
  dirty: number;
  updated_at: number;
};
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

const retentionIntervalMs = 60 * 60_000;

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

// The Yjs room for one project: a Durable Object that syncs, persists, and
// flushes collaborative sources. Apps subclass it to supply what collaboration
// does not own: project access, which principals are anonymous, and what to do
// after sources change. The subclass is the class Wrangler binds.
export abstract class CollaborationRoom<
  E extends CollaborationEnv = CollaborationEnv,
> extends DurableObject<E> {
  // Locks the project and checks access. Runs inside a Postgres transaction.
  protected abstract lockProject(
    request: ProjectAccessRequest,
  ): Promise<{ canWrite: boolean }>;
  // Anonymous principals, such as share-link viewers, have no presence.
  protected abstract isAnonymous(userId: string): boolean;
  // Runs after the room persists sources, for example to invalidate builds.
  protected abstract sourcesChanged(projectId: string): Promise<void>;

  private documents = new Map<string, Y.Doc>();
  // Running text and history sizes, so edits are checked without re-encoding.
  private sizes = new WeakMap<Y.Doc, Usage>();
  private queue: Promise<void> = Promise.resolve();
  // Verified access per user. Revocation paths clear it through invalidateAccess,
  // and the alarm re-verifies every connected user as a backstop.
  private access = new Map<string, { canWrite: boolean }>();
  private accessGeneration = 0;

  constructor(ctx: DurableObjectState, env: E) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS documents (
      node_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, snapshot BLOB NOT NULL,
      object_key TEXT, dirty INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT, node_id TEXT NOT NULL, data BLOB NOT NULL, bytes INTEGER NOT NULL)`);
    initializeChunks(ctx.storage.sql);
    ctx.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS updates_by_node ON updates (node_id, id)",
    );
    ctx.blockConcurrencyWhile(async () => {
      if (
        (this.ctx.getWebSockets().length ||
          this.ctx.storage.sql
            .exec("SELECT node_id FROM documents LIMIT 1")
            .toArray().length) &&
        (await this.ctx.storage.getAlarm()) === null
      )
        await this.ctx.storage.setAlarm(Date.now() + 2000);
    });
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation);
    this.queue = next.then(
      () => {},
      () => {},
    );
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

  private row(nodeId: string) {
    return this.ctx.storage.sql
      .exec<DocumentRow>("SELECT * FROM documents WHERE node_id = ?", nodeId)
      .toArray()[0];
  }

  private removeDocument(nodeId: string) {
    this.ctx.storage.transactionSync(() => {
      deleteUpdates(this.ctx.storage.sql, nodeId);
      this.ctx.storage.sql.exec(
        "DELETE FROM snapshot_chunks WHERE node_id = ?",
        nodeId,
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM documents WHERE node_id = ?",
        nodeId,
      );
    });
    this.documents.get(nodeId)?.destroy();
    this.documents.delete(nodeId);
    for (const ws of this.ctx.getWebSockets(nodeId))
      if (ws.readyState === WebSocket.OPEN) ws.close(1008, "File removed");
  }

  private async purgeDeleted(projectId: string) {
    const nodeIds = new Set(
      this.ctx.storage.sql
        .exec<Pick<DocumentRow, "node_id">>(
          "SELECT node_id FROM documents WHERE project_id = ?",
          projectId,
        )
        .toArray()
        .map((row) => row.node_id),
    );
    for (const ws of this.ctx.getWebSockets()) {
      const info = attachmentSchema.parse(ws.deserializeAttachment());
      if (info.projectId === projectId) nodeIds.add(info.nodeId);
    }
    const live = await this.withDb((db) =>
      db
        .select({
          id: projectNode.id,
          objectKey: projectNode.objectKey,
          updatedAt: projectNode.updatedAt,
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
        .where(and(eq(project.id, projectId), isNull(project.deletedAt))),
    );
    const nodes = new Map<string, SourceNode>();
    for (const { id, objectKey, updatedAt } of live)
      if (id && updatedAt) nodes.set(id, { objectKey, updatedAt });
    for (const nodeId of nodeIds)
      if (!nodes.has(nodeId)) this.removeDocument(nodeId);
    return { projectDeleted: live.length === 0, nodes };
  }

  // Bring loaded documents up to date with sources written outside collaboration.
  private async reconcileLoaded(
    projectId: string,
    nodes: Map<string, SourceNode>,
  ) {
    for (const [nodeId, doc] of this.documents) {
      const node = nodes.get(nodeId);
      if (node && this.row(nodeId)?.project_id === projectId)
        await this.reconcileSource({ nodeId, projectId }, doc, node);
    }
  }

  async purgeDeletedSources(projectId: string) {
    return this.serial(async () => {
      const result = await this.purgeDeleted(projectId);
      for (const prefix of [
        `history/${projectId}/`,
        ...(result.projectDeleted ? [`git/${projectId}/`] : []),
      ]) {
        let cursor: string | undefined;
        do {
          const page = await this.env.SOURCES.list({
            prefix,
            cursor,
            limit: 100,
          });
          if (page.objects.length)
            await this.env.SOURCES.delete(
              page.objects.map((object) => object.key),
            );
          cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);
      }
      return { projectDeleted: result.projectDeleted };
    });
  }

  // Loading reconciles with Postgres; a cached document reconciles only when the
  // caller already holds a fresh node, so edits do not query the database.
  private async document(
    info: Pick<Attachment, "nodeId" | "projectId">,
    options: { node?: SourceNode; recover?: boolean } = {},
  ) {
    const { recover = true } = options;
    const cached = this.documents.get(info.nodeId);
    if (cached) {
      if (options.node) await this.reconcileSource(info, cached, options.node);
      return cached;
    }
    const doc = new Y.Doc();
    const row = this.row(info.nodeId);
    if (row) {
      Y.applyUpdate(
        doc,
        readSnapshot(this.ctx.storage.sql, info.nodeId, row.snapshot),
      );
      for (const update of readUpdates(this.ctx.storage.sql, info.nodeId))
        Y.applyUpdate(doc, update);
    } else {
      const node =
        options.node ??
        (await this.withDb((db) =>
          sourceNode(db, info.projectId, info.nodeId),
        ));
      const object = node.objectKey
        ? await this.env.SOURCES.get(node.objectKey)
        : null;
      if (node.objectKey && !object)
        throw new Error("Saved source is missing from storage");
      doc.getText("source").insert(0, object ? await object.text() : "");
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          "INSERT INTO documents (node_id, project_id, snapshot, object_key) VALUES (?, ?, ?, ?)",
          info.nodeId,
          info.projectId,
          new Uint8Array(),
          node.objectKey,
        );
        writeSnapshot(
          this.ctx.storage.sql,
          info.nodeId,
          Y.encodeStateAsUpdate(doc),
        );
      });
    }
    this.documents.set(info.nodeId, doc);
    if (row && recover) {
      try {
        const node =
          options.node ??
          (await this.withDb((db) =>
            sourceNode(db, info.projectId, info.nodeId),
          ));
        // Reconcile a commit whose SQLite acknowledgement was interrupted. A pending
        // write that never committed must stay editable, including after quota errors.
        if (row.dirty && node.objectKey !== row.object_key) {
          const hash = await hashText(doc.getText("source").toString());
          if (node.objectKey !== `projects/${info.projectId}/sources/${hash}`)
            throw new Error(
              "Source changed outside collaboration. Reopen the project before saving.",
            );
          this.ctx.storage.sql.exec(
            "UPDATE documents SET object_key = ?, updated_at = ?, dirty = 0 WHERE node_id = ?",
            node.objectKey,
            node.updatedAt.getTime(),
            info.nodeId,
          );
        }
        await this.reconcileSource(info, doc, node);
      } catch (error) {
        this.documents.delete(info.nodeId);
        doc.destroy();
        throw error;
      }
    }
    return doc;
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

  private remember(userId: string, generation: number, canWrite: boolean) {
    // An invalidation during the check may have revoked what it read.
    if (generation !== this.accessGeneration) return false;
    this.access.set(userId, { canWrite });
    return true;
  }

  private disconnect(userId: string) {
    this.access.delete(userId);
    for (const ws of this.ctx.getWebSockets())
      if (
        ws.readyState === WebSocket.OPEN &&
        attachmentSchema.parse(ws.deserializeAttachment()).userId === userId
      )
        ws.close(1008, "Project access could not be verified");
  }

  private async verifyAccess(info: Pick<Attachment, "projectId" | "userId">) {
    for (;;) {
      const cached = this.access.get(info.userId);
      if (cached) return cached;
      const generation = this.accessGeneration;
      try {
        const { canWrite } = await this.withDb((db) =>
          db.transaction((tx) =>
            this.lockProject({
              tx,
              projectId: info.projectId,
              userId: info.userId,
              access: "read",
            }),
          ),
        );
        if (this.remember(info.userId, generation, canWrite))
          return { canWrite };
      } catch (error) {
        // Failure to verify access must never leave a recipient subscribed.
        this.disconnect(info.userId);
        throw error;
      }
    }
  }

  // Revocation paths call this, possibly inside the revoking transaction, so it
  // must not wait on Postgres. Later deliveries re-verify behind the revocation's
  // locks, and the alarm closes revoked sockets that receive nothing.
  async invalidateAccess(userIds?: string[]) {
    this.accessGeneration++;
    if (userIds) for (const userId of userIds) this.access.delete(userId);
    else this.access.clear();
    await this.ctx.storage.setAlarm(Date.now());
  }

  private async verifyConnected() {
    const connected = new Map<string, Attachment>();
    for (const ws of this.ctx.getWebSockets())
      if (ws.readyState === WebSocket.OPEN) {
        const info = attachmentSchema.parse(ws.deserializeAttachment());
        connected.set(info.userId, info);
      }
    this.accessGeneration++;
    this.access.clear();
    for (const info of connected.values())
      await this.verifyAccess(info).catch(() => {});
  }

  private send(ws: WebSocket, message: ServerMessage) {
    return this.deliver(ws, isPresence(message), encodeServerMessage(message));
  }

  private async deliver(
    ws: WebSocket,
    presence: boolean,
    frame: string | Uint8Array,
  ) {
    if (ws.readyState !== WebSocket.OPEN) return;
    const info = attachmentSchema.parse(ws.deserializeAttachment());
    // Outdated tabs cannot read binary frames.
    if (!info.binary && typeof frame !== "string") return;
    // Anonymous share-link viewers never see who else is in the project.
    if (presence && this.isAnonymous(info.userId)) return;
    try {
      await this.verifyAccess(info);
    } catch {
      ws.close(1008, "Project access could not be verified");
      return;
    }
    if (ws.readyState === WebSocket.OPEN) ws.send(frame);
  }

  private async broadcast(
    nodeId: string,
    message: ServerMessage,
    except?: WebSocket,
  ) {
    // Encode once for every peer.
    const frame = encodeServerMessage(message);
    for (const peer of this.ctx.getWebSockets(nodeId))
      if (peer !== except) await this.deliver(peer, isPresence(message), frame);
  }

  // Signed-in users with an open file, leaving out the `closing` socket.
  private present(closing?: WebSocket) {
    const users = new Map<string, Attachment>();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === closing || ws.readyState !== WebSocket.OPEN) continue;
      const info = attachmentSchema.parse(ws.deserializeAttachment());
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
  // awareness alone would miss people working in other files.
  private async broadcastPeople(message: ServerMessage, except: WebSocket) {
    for (const ws of this.ctx.getWebSockets())
      if (
        ws !== except &&
        ws.readyState === WebSocket.OPEN &&
        attachmentSchema.parse(ws.deserializeAttachment()).people
      )
        await this.send(ws, message);
  }

  override async fetch(request: Request) {
    return this.serial(async () => {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
        return new Response("WebSocket required", { status: 426 });
      const info = attachmentSchema.parse(
        JSON.parse(request.headers.get("X-Collaboration-Session") ?? "null"),
      );
      const generation = this.accessGeneration;
      const { node, canWrite } = await this.withDb((db) =>
        collaborationAccess(db, info.projectId, info.nodeId, info.userId, {
          register: true,
          lock: (request) => this.lockProject(request),
        }),
      );
      this.remember(info.userId, generation, canWrite);
      if (info.binary) await this.document(info, { node });
      const joined =
        info.binary &&
        !this.isAnonymous(info.userId) &&
        !this.present().has(info.userId);
      const pair = new WebSocketPair();
      pair[1].serializeAttachment(info);
      this.ctx.acceptWebSocket(pair[1], [info.nodeId]);
      // The new socket asks for the list itself, when it synchronizes.
      if (joined) await this.broadcastPeople(this.people(), pair[1]);
      const alarm = await this.ctx.storage.getAlarm();
      if (alarm === null || alarm > Date.now() + liveProjectAccessIntervalMs)
        await this.ctx.storage.setAlarm(
          Date.now() + liveProjectAccessIntervalMs,
        );
      return new Response(null, { status: 101, webSocket: pair[0] });
    });
  }

  private async apply(info: Attachment, bytes: Uint8Array) {
    const doc = await this.document(info);
    const usage = checkUpdate(
      doc,
      this.sizes.get(doc) ?? measureUsage(doc),
      bytes,
    );
    Y.applyUpdate(doc, bytes);
    this.sizes.set(doc, usage);
    try {
      this.ctx.storage.transactionSync(() => {
        appendUpdate(this.ctx.storage.sql, info.nodeId, bytes);
        this.ctx.storage.sql.exec(
          "UPDATE documents SET dirty = 1 WHERE node_id = ?",
          info.nodeId,
        );
        const stored = this.ctx.storage.sql
          .exec<{ count: number; bytes: number }>(
            "SELECT count(*) AS count, coalesce(sum(bytes), 0) AS bytes FROM updates WHERE node_id = ?",
            info.nodeId,
          )
          .one();
        if (stored.count >= 64 || stored.bytes >= 256 * 1024) {
          const snapshot = Y.encodeStateAsUpdate(doc);
          writeSnapshot(this.ctx.storage.sql, info.nodeId, snapshot);
          deleteUpdates(this.ctx.storage.sql, info.nodeId);
          usage.historyBytes = snapshot.byteLength;
        }
      });
    } catch (error) {
      // Reload from storage so the room never holds an unpersisted update.
      this.documents.delete(info.nodeId);
      doc.destroy();
      throw error;
    }
    const flushAt = Date.now() + 2000;
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > flushAt)
      await this.ctx.storage.setAlarm(flushAt);
    await this.broadcast(info.nodeId, { type: "update", update: bytes });
  }

  override async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ) {
    return this.serial(async () => {
      if (ws.readyState !== WebSocket.OPEN) return;
      let requestId: string | undefined;
      try {
        const info = attachmentSchema.parse(ws.deserializeAttachment());
        if (!info.binary) {
          // The tab keeps its offline edits and merges them after reloading.
          await this.send(ws, {
            type: "error",
            message: outdatedClientMessage,
          });
          return;
        }
        const data = decodeClientMessage(message);
        if (data.type === "save") requestId = data.id;
        const access = await this.verifyAccess(info);
        const doc = await this.document(info);
        switch (data.type) {
          case "sync": {
            const row = this.row(info.nodeId);
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
            for (const peer of this.ctx.getWebSockets(info.nodeId)) {
              const state = attachmentSchema.parse(
                peer.deserializeAttachment(),
              ).awareness;
              if (peer !== ws && state && Date.now() - state.at < 30_000)
                await this.send(ws, {
                  type: "awareness",
                  update: state.update,
                });
            }
            break;
          }
          case "update":
          case "save": {
            if (!access.canWrite)
              throw new Error("Viewers cannot edit documents");
            if (data.type === "update") await this.apply(info, data.update);
            if (data.type === "save") {
              const version = await this.flush(info.nodeId);
              if (!version) throw new Error("File not found");
              await this.send(ws, {
                type: "saved",
                id: data.id,
                value: doc.getText("source").toString(),
                ...version,
              });
            }
            break;
          }
          case "awareness": {
            // Share-link viewers are not shown to collaborators.
            if (this.isAnonymous(info.userId)) break;
            const presence = readAwareness(
              data.update,
              info.clientId,
              this.user(info),
            );
            if (info.awareness && presence.clock < info.awareness.clock) break;
            info.awareness = {
              clock: presence.clock,
              update: presence.frame,
              at: Date.now(),
            };
            ws.serializeAttachment(info);
            await this.broadcast(
              info.nodeId,
              { type: "awareness", update: info.awareness.update },
              ws,
            );
            break;
          }
        }
      } catch (error) {
        await this.send(ws, {
          type: "error",
          message:
            error instanceof Error ? error.message : "Collaboration failed",
          ...(requestId ? { id: requestId } : {}),
        });
      }
    });
  }

  private async flush(nodeId: string) {
    const row = this.row(nodeId);
    if (!row) return null;
    const doc =
      this.documents.get(nodeId) ??
      (await this.document(
        { nodeId, projectId: row.project_id },
        { recover: false },
      ));
    let version;
    try {
      version = await this.withDb((db) =>
        persistMergedSource({
          db,
          bucket: this.env.SOURCES,
          projectId: row.project_id,
          nodeId,
          expectedObjectKey: row.object_key,
          value: doc.getText("source").toString(),
        }),
      );
    } catch (error) {
      this.documents.delete(nodeId);
      doc.destroy();
      throw error;
    }
    if (!version) {
      this.removeDocument(nodeId);
      return null;
    }
    this.ctx.storage.sql.exec(
      "UPDATE documents SET object_key = ?, updated_at = ?, dirty = 0 WHERE node_id = ?",
      version.objectKey,
      version.updatedAt,
      nodeId,
    );
    await this.sourcesChanged(row.project_id);
    return version;
  }

  override async alarm() {
    return this.serial(async () => {
      try {
        await this.verifyConnected();
        const projectIds = new Set(
          this.ctx.storage.sql
            .exec<Pick<DocumentRow, "project_id">>(
              "SELECT DISTINCT project_id FROM documents",
            )
            .toArray()
            .map((row) => row.project_id),
        );
        for (const projectId of projectIds)
          await this.reconcileLoaded(
            projectId,
            (await this.purgeDeleted(projectId)).nodes,
          );
        for (const row of this.ctx.storage.sql
          .exec<DocumentRow>("SELECT * FROM documents WHERE dirty = 1")
          .toArray()) {
          try {
            await this.flush(row.node_id);
          } catch (error) {
            console.error("Collaborative source flush failed", {
              projectId: row.project_id,
              nodeId: row.node_id,
              error,
            });
            await this.broadcast(row.node_id, {
              type: "error",
              message:
                "Edits are retained in collaboration, but source saving failed. " +
                (error instanceof Error ? error.message : "Retrying."),
            });
          }
        }
      } finally {
        const active =
          this.ctx
            .getWebSockets()
            .some((ws) => ws.readyState === WebSocket.OPEN) ||
          this.ctx.storage.sql
            .exec("SELECT node_id FROM documents WHERE dirty = 1 LIMIT 1")
            .toArray().length;
        if (
          active ||
          this.ctx.storage.sql
            .exec("SELECT node_id FROM documents LIMIT 1")
            .toArray().length
        )
          await this.ctx.storage.setAlarm(
            Date.now() +
              (active ? liveProjectAccessIntervalMs : retentionIntervalMs),
          );
      }
    });
  }

  async saveSource(options: {
    data: z.infer<typeof saveSourceSchema>;
    userId: string;
    name?: string;
  }) {
    return this.serial(async () => {
      const { data, userId } = options;
      const info: Attachment = {
        projectId: data.projectId,
        nodeId: data.nodeId,
        userId,
        name: options.name ?? "Collaborator",
        clientId: 0,
        awareness: null,
        binary: false,
        people: false,
      };
      const access = await this.withDb((db) =>
        collaborationAccess(db, info.projectId, info.nodeId, userId, {
          register: true,
          lock: (request) => this.lockProject(request),
        }),
      );
      if (!access.canWrite) throw new Error("Viewers cannot edit documents");
      const doc = await this.document(info, { node: access.node });
      const row = this.row(data.nodeId);
      if (!row || row.dirty || row.object_key !== data.expectedObjectKey)
        throw new Error(
          "File changed on the server. Recover your draft in the collaborative editor.",
        );
      const text = doc.getText("source");
      const value = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: false,
      }).decode(decodeSource(data.content));
      const candidate = new Y.Doc();
      Y.applyUpdate(candidate, Y.encodeStateAsUpdate(doc));
      const target = candidate.getText("source");
      candidate.transact(() => {
        for (const change of formatChanges(text.toString(), value).reverse()) {
          target.delete(change.from, change.to - change.from);
          target.insert(change.from, change.insert);
        }
      });
      const update = Y.encodeStateAsUpdate(candidate, Y.encodeStateVector(doc));
      candidate.destroy();
      await this.apply(info, update);
      const version = await this.flush(data.nodeId);
      if (!version) throw new Error("File not found");
      return version;
    });
  }

  // Runs an operation that reads or rewrites a project's saved sources outside
  // collaboration, such as Git. The room checks access, flushes dirty documents
  // first, and with `rewritesSources` reloads open documents afterward.
  protected async withSavedSources<T>(options: {
    projectId: string;
    userId: string;
    access: "read" | "write";
    rewritesSources: boolean;
    run: (db: Db) => Promise<T>;
  }) {
    return this.serial(async () => {
      await this.withDb((db) =>
        db.transaction((tx) =>
          this.lockProject({
            tx,
            projectId: options.projectId,
            userId: options.userId,
            access: options.access,
          }),
        ),
      );
      await this.purgeDeleted(options.projectId);
      for (const row of this.ctx.storage.sql
        .exec<DocumentRow>(
          "SELECT * FROM documents WHERE project_id = ? AND dirty = 1",
          options.projectId,
        )
        .toArray())
        await this.flush(row.node_id);
      const result = await this.withDb(options.run);
      if (options.rewritesSources) {
        const { nodes } = await this.purgeDeleted(options.projectId);
        for (const row of this.ctx.storage.sql
          .exec<DocumentRow>(
            "SELECT * FROM documents WHERE project_id = ?",
            options.projectId,
          )
          .toArray()) {
          const node = nodes.get(row.node_id);
          if (node)
            await this.document(
              { nodeId: row.node_id, projectId: row.project_id },
              { node },
            );
        }
        await this.sourcesChanged(options.projectId);
      }
      return result;
    });
  }

  private async reconcileSource(
    info: Pick<Attachment, "nodeId" | "projectId">,
    doc: Y.Doc,
    node: SourceNode,
  ) {
    const row = this.row(info.nodeId);
    if (!row || row.dirty) return;
    if (row.object_key === node.objectKey) return;
    const object = node.objectKey
      ? await this.env.SOURCES.get(node.objectKey)
      : null;
    if (node.objectKey && !object) throw new Error("Saved source is missing");
    const value = object ? await object.text() : "";
    const vector = Y.encodeStateVector(doc);
    const text = doc.getText("source");
    doc.transact(() => {
      for (const change of formatChanges(text.toString(), value).reverse()) {
        text.delete(change.from, change.to - change.from);
        text.insert(change.from, change.insert);
      }
    });
    const update = Y.encodeStateAsUpdate(doc, vector);
    this.sizes.delete(doc);
    this.ctx.storage.transactionSync(() => {
      writeSnapshot(
        this.ctx.storage.sql,
        info.nodeId,
        Y.encodeStateAsUpdate(doc),
      );
      deleteUpdates(this.ctx.storage.sql, info.nodeId);
      this.ctx.storage.sql.exec(
        "UPDATE documents SET object_key = ?, updated_at = ? WHERE node_id = ?",
        node.objectKey,
        node.updatedAt.getTime(),
        info.nodeId,
      );
    });
    await this.broadcast(info.nodeId, { type: "update", update });
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string) {
    return this.serial(async () => {
      const info = attachmentSchema.parse(ws.deserializeAttachment());
      if (!info.binary) {
        ws.close(closeCode(code), reason);
        return;
      }
      const update = awarenessFrame(
        info.clientId,
        (info.awareness?.clock ?? 0) + 1,
        null,
      );
      await this.broadcast(info.nodeId, { type: "awareness", update }, ws);
      if (!this.isAnonymous(info.userId) && !this.present(ws).has(info.userId))
        await this.broadcastPeople(this.people(ws), ws);
      ws.close(closeCode(code), reason);
    });
  }

  override async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws, 1011, "Connection failed");
  }
}
