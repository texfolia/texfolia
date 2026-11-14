import { createDb, type Db } from "@texfolia/db";
import { project, projectNode } from "@texfolia/db/schema";
import { DurableObject } from "cloudflare:workers";
import { and, eq, isNull } from "drizzle-orm";
import * as Y from "yjs";
import { z } from "zod";

import { formatChanges } from "../latex/format";
import { hashSource } from "../latex/source-sync";
import { liveProjectAccessIntervalMs } from "../live-project.server";
import {
  decodeSource,
  encodeSource,
  maxSourceFileBytes,
  type saveSourceSchema,
} from "../project-source";
import { invalidateSourceBuild } from "../project-source.server";
import {
  awarenessFrame,
  clientMessageSchema,
  maxCollaborationBytes,
  readAwareness,
  type ServerMessage,
} from "./protocol";
import { collaborationAccess, persistMergedSource } from "./sources.server";
import {
  initializeChunks,
  readSnapshot,
  writeSnapshot,
  appendUpdate,
  readUpdates,
  deleteUpdates,
} from "./storage";

const attachmentSchema = z.object({
  projectId: z.uuid(),
  nodeId: z.uuid(),
  userId: z.string(),
  name: z.string().max(200),
  clientId: z.number().int().nonnegative(),
  awareness: z
    .object({ clock: z.number(), update: z.string(), at: z.number() })
    .nullable(),
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
const retentionIntervalMs = 60 * 60_000;

export class ProjectCollaboration extends DurableObject<Env> {
  private documents = new Map<string, Y.Doc>();
  private queue: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
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
        .select({ id: projectNode.id })
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
    const liveIds = new Set(live.map((node) => node.id));
    for (const nodeId of nodeIds)
      if (!liveIds.has(nodeId)) this.removeDocument(nodeId);
    return { projectDeleted: live.length === 0 };
  }

  async purgeDeletedSources(projectId: string) {
    return this.serial(() => this.purgeDeleted(projectId));
  }

  private async document(
    info: Pick<Attachment, "nodeId" | "projectId" | "userId">,
    recover = true,
  ) {
    const cached = this.documents.get(info.nodeId);
    if (cached) return cached;
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
      const source = await this.withDb(async (db) => {
        const { node } = await collaborationAccess(
          db,
          info.projectId,
          info.nodeId,
          info.userId,
        );
        const object = node.objectKey
          ? await this.env.SOURCES.get(node.objectKey)
          : null;
        if (node.objectKey && !object)
          throw new Error("Saved source is missing from storage");
        return {
          value: object ? await object.text() : "",
          objectKey: node.objectKey,
        };
      });
      doc.getText("source").insert(0, source.value);
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          "INSERT INTO documents (node_id, project_id, snapshot, object_key) VALUES (?, ?, ?, ?)",
          info.nodeId,
          info.projectId,
          new Uint8Array(),
          source.objectKey,
        );
        writeSnapshot(
          this.ctx.storage.sql,
          info.nodeId,
          Y.encodeStateAsUpdate(doc),
        );
      });
    }
    this.documents.set(info.nodeId, doc);
    // Reconcile a commit whose SQLite acknowledgement was interrupted. A pending
    // write that never committed must stay editable, including after quota errors.
    if (row?.dirty && recover) {
      try {
        const { node } = await this.withDb((db) =>
          collaborationAccess(db, info.projectId, info.nodeId, info.userId),
        );
        if (node.objectKey !== row.object_key) {
          const hash = await hashSource(
            new TextEncoder().encode(doc.getText("source").toString()),
          );
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

  private async checkRecipient(ws: WebSocket, deliver?: () => void) {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      const info = attachmentSchema.parse(ws.deserializeAttachment());
      await this.withDb((db) =>
        collaborationAccess(db, info.projectId, info.nodeId, info.userId, {
          deliver: () => {
            if (ws.readyState === WebSocket.OPEN) deliver?.();
          },
        }),
      );
    } catch {
      // Failure to verify access must never leave a recipient subscribed.
      ws.close(1008, "Project access could not be verified");
    }
  }

  private async send(ws: WebSocket, message: ServerMessage) {
    await this.checkRecipient(ws, () => ws.send(JSON.stringify(message)));
  }

  private async broadcast(
    nodeId: string,
    message: ServerMessage,
    except?: WebSocket,
  ) {
    for (const peer of this.ctx.getWebSockets(nodeId))
      if (peer !== except) await this.send(peer, message);
  }

  override async fetch(request: Request) {
    return this.serial(async () => {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
        return new Response("WebSocket required", { status: 426 });
      const info = attachmentSchema.parse(
        JSON.parse(request.headers.get("X-Collaboration-Session") ?? "null"),
      );
      await this.withDb((db) =>
        collaborationAccess(db, info.projectId, info.nodeId, info.userId, {
          register: true,
        }),
      );
      await this.document(info);
      const pair = new WebSocketPair();
      pair[1].serializeAttachment(info);
      this.ctx.acceptWebSocket(pair[1], [info.nodeId]);
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
    // Validate on a disposable document so a rejected update cannot poison the room.
    const candidate = new Y.Doc();
    try {
      Y.applyUpdate(candidate, Y.encodeStateAsUpdate(doc));
      Y.applyUpdate(candidate, bytes);
      if (
        [...candidate.share.keys()].some((key) => key !== "source") ||
        candidate
          .getText("source")
          .toDelta()
          .some(
            (part: { insert?: unknown; attributes?: unknown }) =>
              typeof part.insert !== "string" || part.attributes !== undefined,
          ) ||
        new TextEncoder().encode(candidate.getText("source").toString())
          .byteLength > maxSourceFileBytes ||
        Y.encodeStateAsUpdate(candidate).byteLength > maxCollaborationBytes
      )
        throw new Error(
          "Collaborative document exceeds its text or history limit",
        );
      this.ctx.storage.transactionSync(() => {
        appendUpdate(this.ctx.storage.sql, info.nodeId, bytes);
        this.ctx.storage.sql.exec(
          "UPDATE documents SET dirty = 1 WHERE node_id = ?",
          info.nodeId,
        );
        const usage = this.ctx.storage.sql
          .exec<{ count: number; bytes: number }>(
            "SELECT count(*) AS count, coalesce(sum(bytes), 0) AS bytes FROM updates WHERE node_id = ?",
            info.nodeId,
          )
          .one();
        if (usage.count >= 64 || usage.bytes >= 256 * 1024) {
          writeSnapshot(
            this.ctx.storage.sql,
            info.nodeId,
            Y.encodeStateAsUpdate(candidate),
          );
          deleteUpdates(this.ctx.storage.sql, info.nodeId);
        }
      });
      Y.applyUpdate(doc, bytes);
    } finally {
      candidate.destroy();
    }
    const flushAt = Date.now() + 2000;
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > flushAt)
      await this.ctx.storage.setAlarm(flushAt);
    await this.broadcast(info.nodeId, {
      type: "update",
      update: encodeSource(bytes),
    });
  }

  override async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ) {
    return this.serial(async () => {
      if (ws.readyState !== WebSocket.OPEN) return;
      let requestId: string | undefined;
      try {
        if (
          typeof message !== "string" ||
          message.length > 4 * Math.ceil(maxCollaborationBytes / 3) + 1024
        )
          throw new Error("Invalid collaboration message");
        const data = clientMessageSchema.parse(JSON.parse(message));
        if (data.type === "save") requestId = data.id;
        const info = attachmentSchema.parse(ws.deserializeAttachment());
        const access = await this.withDb((db) =>
          collaborationAccess(db, info.projectId, info.nodeId, info.userId),
        );
        const doc = await this.document(info);
        switch (data.type) {
          case "sync":
            await this.send(ws, {
              type: "sync",
              update: encodeSource(
                Y.encodeStateAsUpdate(doc, decodeSource(data.vector)),
              ),
              vector: encodeSource(Y.encodeStateVector(doc)),
              canWrite: access.canWrite,
              user: this.user(info),
            });
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
          case "update":
          case "save": {
            if (!access.canWrite)
              throw new Error("Viewers cannot edit documents");
            await this.apply(info, decodeSource(data.update));
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
            const presence = readAwareness(
              decodeSource(data.update),
              info.clientId,
              this.user(info),
            );
            if (info.awareness && presence.clock < info.awareness.clock) break;
            info.awareness = {
              clock: presence.clock,
              update: encodeSource(presence.frame),
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
        { nodeId, projectId: row.project_id, userId: "" },
        false,
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
    await invalidateSourceBuild(row.project_id, this.env.COMPILER);
    return version;
  }

  override async alarm() {
    return this.serial(async () => {
      try {
        for (const ws of this.ctx.getWebSockets())
          await this.checkRecipient(ws);
        const projectIds = new Set(
          this.ctx.storage.sql
            .exec<Pick<DocumentRow, "project_id">>(
              "SELECT DISTINCT project_id FROM documents",
            )
            .toArray()
            .map((row) => row.project_id),
        );
        for (const projectId of projectIds) await this.purgeDeleted(projectId);
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
  }) {
    return this.serial(async () => {
      const { data, userId } = options;
      const info: Attachment = {
        projectId: data.projectId,
        nodeId: data.nodeId,
        userId,
        name: "",
        clientId: 0,
        awareness: null,
      };
      const access = await this.withDb((db) =>
        collaborationAccess(db, info.projectId, info.nodeId, userId, {
          register: true,
        }),
      );
      if (!access.canWrite) throw new Error("Viewers cannot edit documents");
      const doc = await this.document(info);
      const row = this.row(data.nodeId);
      if (!row || row.dirty || row.object_key !== data.expectedObjectKey)
        throw new Error(
          "File changed on the server. Recover your draft in the collaborative editor.",
        );
      const text = doc.getText("source");
      const value = new TextDecoder("utf-8", { fatal: true }).decode(
        decodeSource(data.content),
      );
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

  override async webSocketClose(ws: WebSocket, code: number, reason: string) {
    return this.serial(async () => {
      const info = attachmentSchema.parse(ws.deserializeAttachment());
      const update = awarenessFrame(
        info.clientId,
        (info.awareness?.clock ?? 0) + 1,
        null,
      );
      await this.broadcast(
        info.nodeId,
        { type: "awareness", update: encodeSource(update) },
        ws,
      );
      ws.close(code, reason);
    });
  }

  override async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws, 1011, "Connection failed");
  }
}
