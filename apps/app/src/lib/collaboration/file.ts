import { formatChanges } from "@texfolia/editor/latex/format";
import { IndexeddbPersistence } from "y-indexeddb";
import {
  applyAwarenessUpdate,
  Awareness,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import * as Y from "yjs";

import { shareSearchParam } from "../project-share-links.schema";
import { collaborationCachePrefix, stopDocumentCaching } from "./cache";
import {
  collaborationProtocol,
  decodeServerMessage,
  encodeClientMessage,
  protocolSearchParam,
  type ClientMessage,
  type ServerMessage,
} from "./protocol";

type Saved = Extract<ServerMessage, { type: "saved" }>;
type FileStatus = {
  ready: boolean;
  connected: boolean;
  canWrite: boolean;
  error: string;
};

export class CollaborativeFile {
  readonly doc = new Y.Doc();
  readonly text = this.doc.getText("source");
  readonly awareness = new Awareness(this.doc);
  // Lives with the file rather than the editor so undo history survives the
  // editor unmounting while its tab is hidden.
  readonly undoManager = new Y.UndoManager(this.text);
  private persistence: IndexeddbPersistence | undefined;
  private socket: WebSocket | undefined;
  private stopped = false;
  private cacheReady = false;
  private synchronized = false;
  private reconnect: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private pongAt = 0;
  private attempts = 0;
  private listeners = new Set<() => void>();
  // Every document change bumps the revision; a save or clean sync records the
  // revision and object key the server has persisted.
  private revision = 0;
  private savedRevision = 0;
  private savedObjectKey: string | null | undefined;
  private status: FileStatus;
  private saves = new Map<
    string,
    {
      resolve: (saved: Saved) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      revision: number;
    }
  >();

  constructor(
    private options: {
      projectId: string;
      nodeId: string;
      userId: string;
      canWrite: boolean;
      // Read-only share-link viewers authenticate with the link's token.
      shareToken?: string;
      /** `local` is true when this tab made the edit, not a peer or the cache. */
      onChange: (value: string, local?: boolean) => void;
      onSaved?: (saved: Saved) => void;
    },
  ) {
    this.status = {
      ready: false,
      connected: false,
      canWrite: options.canWrite,
      error: "",
    };
    this.awareness.setLocalState(null);
    this.doc.on("update", this.documentChanged);
    this.awareness.on("update", this.awarenessChanged);
    window.addEventListener("online", this.online);
    window.addEventListener("offline", this.offline);
    void this.start();
  }

  refreshAccess(canWrite: boolean) {
    if (this.options.canWrite === canWrite) return;
    this.options.canWrite = canWrite;
    if (!canWrite) this.setStatus({ canWrite: false });
    this.send({
      type: "sync",
      vector: Y.encodeStateVector(this.doc),
    });
  }

  getStatus = () => this.status;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private setStatus(next: Partial<FileStatus>) {
    this.status = { ...this.status, ...next };
    for (const listener of this.listeners) listener();
  }

  private async start() {
    if (this.options.canWrite && typeof indexedDB !== "undefined") {
      try {
        this.persistence = new IndexeddbPersistence(
          `${collaborationCachePrefix(this.options.userId)}${this.options.projectId}.${this.options.nodeId}`,
          this.doc,
        );
        await this.persistence.whenSynced;
        if (this.stopped) return;
        this.persistence.db?.addEventListener("versionchange", (event) => {
          if (event.newVersion !== null) return;
          stopDocumentCaching();
          this.destroy();
          window.location.replace("/");
        });
        if ((await this.persistence.get("initialized")) === 1) {
          this.setStatus({ ready: true });
          this.options.onChange(this.text.toString());
        }
      } catch {
        this.setStatus({
          error:
            "Offline collaboration could not be cached. Keep this page open until connected.",
        });
      }
    }
    this.cacheReady = true;
    if (!this.stopped) this.connect();
  }

  private documentChanged = (update: Uint8Array, origin: unknown) => {
    this.revision++;
    const local = origin !== this && origin !== this.persistence;
    if (this.status.ready) this.options.onChange(this.text.toString(), local);
    if (local && this.synchronized && this.status.canWrite)
      this.send({ type: "update", update });
  };

  private awarenessChanged = (
    {
      added,
      updated,
      removed,
    }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (
      origin === this ||
      !this.synchronized ||
      // Share-link viewers have no presence; the server drops it as well.
      this.options.shareToken ||
      ![...added, ...updated, ...removed].includes(this.doc.clientID)
    )
      return;
    this.send({
      type: "awareness",
      update: encodeAwarenessUpdate(this.awareness, [this.doc.clientID]),
    });
  };

  private offline = () => this.disconnect();

  private disconnect() {
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
    clearInterval(this.heartbeat);
    this.synchronized = false;
    this.setStatus({ connected: false });
    removeAwarenessStates(
      this.awareness,
      [...this.awareness.getStates().keys()].filter(
        (id) => id !== this.doc.clientID,
      ),
      this,
    );
    for (const pending of this.saves.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new Error("Disconnected. Your edits will merge when reconnected."),
      );
    }
    this.saves.clear();
    clearTimeout(this.reconnect);
    if (!this.stopped && navigator.onLine)
      this.reconnect = setTimeout(
        () => this.connect(),
        Math.min(10_000, 250 * 2 ** this.attempts++) + Math.random() * 250,
      );
  }

  private online = () => {
    if (!this.cacheReady) return;
    if (!this.socket || this.socket.readyState === WebSocket.CLOSED) {
      clearTimeout(this.reconnect);
      this.connect();
    }
  };

  private send(message: ClientMessage) {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(encodeClientMessage(message));
    return true;
  }

  private connect() {
    if (this.stopped || this.socket) return;
    const url = new URL(
      `/api/collaboration/${this.options.projectId}/${this.options.nodeId}`,
      window.location.href,
    );
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("clientId", String(this.doc.clientID));
    url.searchParams.set(protocolSearchParam, collaborationProtocol);
    if (this.options.shareToken)
      url.searchParams.set(shareSearchParam, this.options.shareToken);
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.pongAt = Date.now();
      this.send({
        type: "sync",
        vector: Y.encodeStateVector(this.doc),
      });
      this.heartbeat = setInterval(() => {
        if (
          Date.now() - this.pongAt > 45_000 ||
          socket.readyState !== WebSocket.OPEN
        )
          this.disconnect();
        else socket.send("ping");
      }, 15_000);
    };
    socket.onmessage = (event: MessageEvent<unknown>) => {
      if (this.socket !== socket) return;
      if (event.data === "pong") {
        this.pongAt = Date.now();
        return;
      }
      try {
        const data = decodeServerMessage(event.data);
        switch (data.type) {
          case "sync": {
            Y.applyUpdate(this.doc, data.update, this);
            this.synchronized = true;
            this.attempts = 0;
            this.setStatus({
              ready: true,
              connected: true,
              canWrite: data.canWrite,
              error: "",
            });
            this.awareness.setLocalState({
              ...this.awareness.getLocalState(),
              user: data.user,
            });
            let dirty = data.dirty;
            if (data.canWrite) {
              const pending = Y.encodeStateAsUpdate(this.doc, data.vector);
              if (pending.length > 2) {
                this.send({ type: "update", update: pending });
                dirty = true;
              }
            }
            this.savedRevision = dirty ? -1 : this.revision;
            this.savedObjectKey = data.objectKey;
            this.options.onChange(this.text.toString());
            if (this.persistence)
              void this.persistence.set("initialized", 1).catch(() => {
                this.setStatus({
                  error: "Offline collaboration could not be cached.",
                });
              });
            break;
          }
          case "update":
            Y.applyUpdate(this.doc, data.update, this);
            break;
          case "awareness":
            applyAwarenessUpdate(this.awareness, data.update, this);
            break;
          case "saved": {
            this.options.onSaved?.(data);
            this.setStatus({ error: "" });
            const pending = this.saves.get(data.id);
            if (pending) {
              clearTimeout(pending.timer);
              this.savedRevision = pending.revision;
              this.savedObjectKey = data.objectKey;
              pending.resolve(data);
              this.saves.delete(data.id);
            }
            break;
          }
          case "error": {
            this.setStatus({
              error: data.message,
              ...(data.message === "Viewers cannot edit documents"
                ? { canWrite: false }
                : {}),
            });
            const pending = data.id ? this.saves.get(data.id) : undefined;
            if (pending && data.id) {
              clearTimeout(pending.timer);
              pending.reject(new Error(data.message));
              this.saves.delete(data.id);
            }
            break;
          }
        }
      } catch {
        this.setStatus({
          error: "Could not synchronize this file. Reconnect to try again.",
        });
        socket.close();
      }
    };
    socket.onclose = () => {
      if (this.socket === socket) this.disconnect();
    };
    socket.onerror = () => {
      if (this.socket === socket) this.disconnect();
    };
  }

  replace(value: string) {
    if (!this.status.ready || !this.status.canWrite)
      throw new Error("Wait for this file to synchronize before editing.");
    this.doc.transact(() => {
      for (const change of formatChanges(
        this.text.toString(),
        value,
      ).reverse()) {
        this.text.delete(change.from, change.to - change.from);
        this.text.insert(change.from, change.insert);
      }
    });
  }

  /** Whether the server has persisted every change as `objectKey`. */
  isSaved(objectKey: string | null | undefined) {
    return (
      this.synchronized &&
      this.revision === this.savedRevision &&
      this.savedObjectKey === objectKey
    );
  }

  save(): Promise<Saved> {
    if (!this.synchronized || !this.status.canWrite)
      return Promise.reject(
        new Error(
          "Connect to collaboration before saving. Offline edits are kept in this browser.",
        ),
      );
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.saves.delete(id);
        reject(
          new Error(
            "Saving timed out. Your edits are retained; try saving again.",
          ),
        );
      }, 30_000);
      this.saves.set(id, { resolve, reject, timer, revision: this.revision });
      // While synchronized, every local update has already been sent on this
      // ordered socket, so the server needs no payload to persist the file.
      this.send({ type: "save", id });
    });
  }

  whenConnected(): Promise<void> {
    if (this.status.connected && this.status.ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(
          new Error(
            "Wait for project files to synchronize before exporting or compiling.",
          ),
        );
      }, 10_000);
      const unsubscribe = this.subscribe(() => {
        if (!this.status.connected || !this.status.ready) return;
        clearTimeout(timer);
        unsubscribe();
        resolve();
      });
    });
  }

  retire() {
    if (this.stopped) return;
    this.stopped = true;
    this.disconnect();
    this.setStatus({
      canWrite: false,
      error:
        "This file was deleted. Your local text is still available to copy.",
    });
  }

  destroy() {
    this.stopped = true;
    this.awareness.setLocalState(null);
    window.removeEventListener("online", this.online);
    window.removeEventListener("offline", this.offline);
    clearTimeout(this.reconnect);
    clearInterval(this.heartbeat);
    this.socket?.close();
    for (const pending of this.saves.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Project closed"));
    }
    this.saves.clear();
    this.awareness.destroy();
    this.undoManager.destroy();
    this.doc.off("update", this.documentChanged);
    void this.persistence?.destroy();
    this.listeners.clear();
    this.doc.destroy();
  }
}
