import * as Y from "yjs";
import { z } from "zod";

import {
  documentVersionSchema,
  historyAuthorSchema,
  historyCadenceMs,
  historyRetentionMs,
  type DocumentVersion,
  type HistoryAuthor,
} from "../document-history";

export type HistoryDocument = { projectId: string; nodeId: string };
type HistoryRow = {
  id: string;
  project_id: string;
  node_id: string;
  created_at: number;
  label: string | null;
  kind: DocumentVersion["kind"];
  authors: string;
  restored_from: string | null;
};

function version(row: HistoryRow): DocumentVersion {
  return documentVersionSchema.parse({
    id: row.id,
    createdAt: row.created_at,
    label: row.label,
    kind: row.kind,
    authors: JSON.parse(row.authors),
    restoredFrom: row.restored_from,
  });
}

export class DocumentHistory {
  constructor(
    private sql: SqlStorage,
    private bucket: R2Bucket,
  ) {
    sql.exec(`CREATE TABLE IF NOT EXISTS history_versions (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, node_id TEXT NOT NULL,
      created_at INTEGER NOT NULL, label TEXT, kind TEXT NOT NULL,
      authors TEXT NOT NULL, restored_from TEXT)`);
    sql.exec(
      "CREATE INDEX IF NOT EXISTS history_by_document ON history_versions (node_id, created_at DESC, id)",
    );
    sql.exec(`CREATE TABLE IF NOT EXISTS history_activity (
      node_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, since INTEGER NOT NULL, authors TEXT NOT NULL)`);
  }

  private key(info: HistoryDocument, id: string) {
    return `history/${info.projectId}/${info.nodeId}/${id}.yjs`;
  }

  list(info: HistoryDocument, before?: { createdAt: number; id: string }) {
    const rows = before
      ? this.sql
          .exec<HistoryRow>(
            "SELECT * FROM history_versions WHERE project_id = ? AND node_id = ? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT 51",
            info.projectId,
            info.nodeId,
            before.createdAt,
            before.createdAt,
            before.id,
          )
          .toArray()
      : this.sql
          .exec<HistoryRow>(
            "SELECT * FROM history_versions WHERE project_id = ? AND node_id = ? ORDER BY created_at DESC, id DESC LIMIT 51",
            info.projectId,
            info.nodeId,
          )
          .toArray();
    const versions = rows.slice(0, 50).map(version);
    const last = versions.at(-1);
    return {
      versions,
      next:
        rows.length > 50 && last
          ? { createdAt: last.createdAt, id: last.id }
          : null,
    };
  }

  hasVersions(info: HistoryDocument) {
    return (
      this.sql
        .exec(
          "SELECT id FROM history_versions WHERE project_id = ? AND node_id = ? LIMIT 1",
          info.projectId,
          info.nodeId,
        )
        .toArray().length > 0
    );
  }

  changed(info: HistoryDocument, author: HistoryAuthor) {
    const activity = this.activity(info.nodeId);
    const authors = activity
      ? z.array(historyAuthorSchema).parse(JSON.parse(activity.authors))
      : [];
    const found = authors.findIndex((entry) => entry.userId === author.userId);
    if (found < 0) authors.push(author);
    else authors[found] = author;
    this.sql.exec(
      "INSERT INTO history_activity (node_id, project_id, since, authors) VALUES (?, ?, ?, ?) ON CONFLICT(node_id) DO UPDATE SET authors = excluded.authors",
      info.nodeId,
      info.projectId,
      Date.now(),
      JSON.stringify(authors),
    );
  }

  private activity(nodeId: string) {
    return this.sql
      .exec<{ authors: string; since: number }>(
        "SELECT authors, since FROM history_activity WHERE node_id = ?",
        nodeId,
      )
      .toArray()[0];
  }

  pending() {
    return this.sql
      .exec<{ node_id: string; project_id: string; since: number }>(
        "SELECT node_id, project_id, since FROM history_activity",
      )
      .toArray();
  }

  async prepare({
    info,
    doc,
    kind,
    label = null,
    author,
    restoredFrom = null,
  }: {
    info: HistoryDocument;
    doc: Y.Doc;
    kind: DocumentVersion["kind"];
    label?: string | null;
    author?: HistoryAuthor;
    restoredFrom?: string | null;
  }) {
    const activity = this.activity(info.nodeId);
    const authors = activity
      ? z.array(historyAuthorSchema).parse(JSON.parse(activity.authors))
      : [];
    if (author && !authors.some((entry) => entry.userId === author.userId))
      authors.push(author);
    const result: DocumentVersion = {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      kind,
      label,
      authors,
      restoredFrom,
    };
    await this.bucket.put(
      this.key(info, result.id),
      Y.encodeStateAsUpdate(doc),
      {
        httpMetadata: { contentType: "application/octet-stream" },
      },
    );
    return result;
  }

  commit(info: HistoryDocument, result: DocumentVersion) {
    this.sql.exec(
      "INSERT INTO history_versions (id, project_id, node_id, created_at, label, kind, authors, restored_from) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      result.id,
      info.projectId,
      info.nodeId,
      result.createdAt,
      result.label,
      result.kind,
      JSON.stringify(result.authors),
      result.restoredFrom,
    );
    this.sql.exec(
      "DELETE FROM history_activity WHERE node_id = ?",
      info.nodeId,
    );
    return result;
  }

  async capture(options: Parameters<DocumentHistory["prepare"]>[0]) {
    const result = await this.prepare(options);
    this.commit(options.info, result);
    return result;
  }

  async read(info: HistoryDocument, id: string) {
    const row = this.sql
      .exec<HistoryRow>(
        "SELECT * FROM history_versions WHERE project_id = ? AND node_id = ? AND id = ?",
        info.projectId,
        info.nodeId,
        id,
      )
      .toArray()[0];
    if (!row) throw new Error("Version not found");
    const object = await this.bucket.get(this.key(info, id));
    if (!object) throw new Error("Version is missing from storage");
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, new Uint8Array(await object.arrayBuffer()));
      return { version: version(row), value: doc.getText("source").toString() };
    } finally {
      doc.destroy();
    }
  }

  label(info: HistoryDocument, id: string, label: string) {
    const rows = this.sql
      .exec<HistoryRow>(
        "UPDATE history_versions SET label = ? WHERE project_id = ? AND node_id = ? AND id = ? RETURNING *",
        label,
        info.projectId,
        info.nodeId,
        id,
      )
      .toArray();
    const row = rows[0];
    if (!row) throw new Error("Version not found");
    return version(row);
  }

  async collect(projectId: string, deleted = false, scanOrphans = false) {
    const expired = this.sql
      .exec<HistoryRow>(
        deleted
          ? "SELECT * FROM history_versions WHERE project_id = ?"
          : "SELECT * FROM history_versions WHERE project_id = ? AND label IS NULL AND created_at < ?",
        ...(deleted
          ? [projectId]
          : [projectId, Date.now() - historyRetentionMs]),
      )
      .toArray();
    // Delete R2 first; a retry can finish interrupted collection safely.
    for (const row of expired) {
      await this.bucket.delete(
        this.key({ projectId, nodeId: row.node_id }, row.id),
      );
      this.sql.exec("DELETE FROM history_versions WHERE id = ?", row.id);
    }
    if (deleted)
      this.sql.exec(
        "DELETE FROM history_activity WHERE project_id = ?",
        projectId,
      );
    if (!deleted && !scanOrphans) return;
    // Also collect uploads interrupted before the SQLite index was committed.
    let cursor: string | undefined;
    do {
      const page = await this.bucket.list({
        prefix: `history/${projectId}/`,
        cursor,
        limit: 100,
      });
      for (const object of page.objects) {
        const id = object.key
          .split("/")
          .at(-1)
          ?.replace(/\.yjs$/, "");
        if (
          deleted ||
          (object.uploaded.getTime() < Date.now() - historyCadenceMs &&
            !this.sql
              .exec("SELECT id FROM history_versions WHERE id = ?", id ?? "")
              .toArray().length)
        )
          await this.bucket.delete(object.key);
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
}
