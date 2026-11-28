import { formatChanges } from "@texfolia/editor";
import { IndexeddbPersistence } from "y-indexeddb";
import {
  applyAwarenessUpdate,
  Awareness,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import * as Y from "yjs";

import {
  collaborationCachePrefix,
  documentCachingStopped,
  stopDocumentCaching,
} from "./cache";
import type {
  CollaborationChannel,
  CollaborationConnection,
} from "./connection";
import {
  collaborationProtocol,
  decodeServerMessage,
  encodeClientMessage,
  peopleSearchParam,
  protocolSearchParam,
  type ClientMessage,
  type MultiplexServerMessage,
  type Person,
  type ServerMessage,
} from "./protocol";
import { markUnsynced, removeMarkers, unsyncedMarkers } from "./unsynced";

type Saved = Extract<ServerMessage, { type: "saved" }>;
type FileStatus = {
  ready: boolean;
  connected: boolean;
  canWrite: boolean;
  error: string;
  /** Everyone with a file open in this project, while connected. */
  people: readonly Person[];
};

// Whether `doc` has edits the server lacked when it sent this sync. An encoded
// update always repeats the whole delete set, so its size cannot tell.
function hasUnsentEdits(
  doc: Y.Doc,
  { update, vector }: { update: Uint8Array; vector: Uint8Array },
) {
  const server = Y.decodeStateVector(vector);
  for (const [client, clock] of Y.decodeStateVector(Y.encodeStateVector(doc)))
    if (clock > (server.get(client) ?? 0)) return true;
  return !Y.equalDeleteSets(
    Y.createDeleteSetFromStructStore(doc.store),
    Y.decodeUpdate(update).ds,
  );
}

export class CollaborativeFile {
  readonly doc = new Y.Doc();
  readonly text = this.doc.getText("source");
  readonly awareness = new Awareness(this.doc);
  // Lives with the file rather than the editor so undo history survives the
  // editor unmounting while its tab is hidden.
  readonly undoManager = new Y.UndoManager(this.text);
  private persistence: IndexeddbPersistence | undefined;
  private socket: WebSocket | undefined;
  private channel: CollaborationChannel | undefined;
  private stopped = false;
  private destroyed = false;
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
  // Local edits count separately, up to the last one the server acknowledged.
  private localRevision = 0;
  private acknowledgedRevision = 0;
  // Markers for unsynced edits that this document's cache includes.
  private markers = new Set<string>();
  private status: FileStatus;
  // Callers of `whenReady` and `whenConnected` still waiting.
  private waiting = new Set<(error: Error) => void>();
  private saves = new Map<
    string,
    {
      resolve: (saved: Saved) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      revision: number;
      localRevision: number;
    }
  >();

  constructor(
    private options: {
      projectId: string;
      nodeId: string;
      userId: string;
      canWrite: boolean;
      // Shared multiplexed project socket; when omitted, opens a per-file socket.
      connection?: CollaborationConnection;
      // Anonymous share-link guests have no presence. Their HttpOnly share
      // cookie authenticates the socket.
      anonymous?: boolean;
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
      people: [],
    };
    this.awareness.setLocalState(null);
    this.doc.on("update", this.documentChanged);
    this.awareness.on("update", this.awarenessChanged);
    if (!options.connection) {
      window.addEventListener("online", this.online);
      window.addEventListener("offline", this.offline);
    }
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
        for (const marker of unsyncedMarkers(this.options))
          this.markers.add(marker);
        this.persistence.db?.addEventListener("versionchange", (event) => {
          if (event.newVersion !== null) return;
          stopDocumentCaching();
          this.destroy();
          window.location.replace("/");
        });
        const initialized = await this.persistence.get("initialized");
        if (this.destroyed) return;
        if (initialized === 1) {
          this.setStatus({ ready: true });
          this.options.onChange(this.text.toString());
        }
      } catch {
        if (this.destroyed) return;
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
    if (local) {
      this.localRevision++;
      if (this.persistence && !documentCachingStopped())
        this.markers.add(markUnsynced(this.options, this.doc.clientID));
    }
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
      this.options.anonymous ||
      ![...added, ...updated, ...removed].includes(this.doc.clientID)
    )
      return;
    this.send({
      type: "awareness",
      update: encodeAwarenessUpdate(this.awareness, [this.doc.clientID]),
    });
  };

  private offline = () => this.disconnect();

  /** Closes the socket or detaches from the shared connection; nothing reaches this file. */
  private detach() {
    if (this.channel) {
      const channel = this.channel;
      this.channel = undefined;
      channel.detach();
    }
    const socket = this.socket;
    this.socket = undefined;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    socket.close();
  }

  private resetConnectionState() {
    this.synchronized = false;
    this.setStatus({ connected: false, people: [] });
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
  }

  private disconnect() {
    this.detach();
    clearInterval(this.heartbeat);
    this.resetConnectionState();
    clearTimeout(this.reconnect);
    if (!this.options.connection && !this.stopped && navigator.onLine)
      this.reconnect = setTimeout(
        () => this.connect(),
        Math.min(10_000, 250 * 2 ** this.attempts++) + Math.random() * 250,
      );
  }

  private online = () => {
    if (!this.cacheReady || this.options.connection) return;
    if (!this.socket || this.socket.readyState === WebSocket.CLOSED) {
      clearTimeout(this.reconnect);
      this.connect();
    }
  };

  private send(message: ClientMessage) {
    if (this.channel) {
      switch (message.type) {
        case "sync":
          return this.channel.send({
            type: "sync",
            nodeId: this.options.nodeId,
            clientId: this.doc.clientID,
            vector: message.vector,
          });
        case "update":
        case "awareness":
          return this.channel.send({
            type: message.type,
            nodeId: this.options.nodeId,
            update: message.update,
          });
        case "save":
          return this.channel.send({
            type: "save",
            nodeId: this.options.nodeId,
            id: message.id,
          });
      }
    }
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(encodeClientMessage(message));
    return true;
  }

  private handleMessage(data: ServerMessage | MultiplexServerMessage) {
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
        if (hasUnsentEdits(this.doc, data)) {
          // Edits from the cache are unacknowledged too.
          this.localRevision++;
          if (data.canWrite) {
            this.send({
              type: "update",
              update: Y.encodeStateAsUpdate(this.doc, data.vector),
            });
            dirty = true;
          }
        } else this.acknowledge(this.localRevision);
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
        this.setStatus({ error: "" });
        const pending = this.saves.get(data.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.savedRevision = pending.revision;
          this.savedObjectKey = data.objectKey;
          this.acknowledge(pending.localRevision);
        }
        this.options.onSaved?.(data);
        pending?.resolve(data);
        this.saves.delete(data.id);
        break;
      }
      case "people":
        this.setStatus({ people: data.people });
        break;
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
      case "closed":
        this.disconnect();
        break;
    }
  }

  private connect() {
    if (this.stopped) return;
    if (this.options.connection) {
      if (this.channel) return;
      const sendSync = () =>
        this.send({
          type: "sync",
          vector: Y.encodeStateVector(this.doc),
        });
      this.channel = this.options.connection.attach(this.options.nodeId, {
        onOpen: () => {
          if (!this.stopped) sendSync();
        },
        onMessage: (data) => {
          if (!this.stopped) this.handleMessage(data);
        },
        onDisconnect: () => {
          if (!this.stopped) this.resetConnectionState();
        },
        onClosed: () => {
          if (!this.stopped) this.disconnect();
        },
      });
      if (this.channel.isOpen()) sendSync();
      return;
    }
    if (this.socket) return;
    const url = new URL(
      `/api/collaboration/${this.options.projectId}/${this.options.nodeId}`,
      window.location.href,
    );
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("clientId", String(this.doc.clientID));
    url.searchParams.set(protocolSearchParam, collaborationProtocol);
    url.searchParams.set(peopleSearchParam, "1");
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
        this.handleMessage(decodeServerMessage(event.data));
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

  /**
   * Applies non-overlapping UTF-16 range edits as one undoable collaborative
   * transaction. Returns false when nothing changed.
   */
  applyEdits(edits: readonly { from: number; to: number; insert: string }[]) {
    if (!this.status.ready || !this.status.canWrite)
      throw new Error("Wait for this file to synchronize before editing.");
    const current = this.text.toString();
    const effective = edits.filter(
      (edit) => current.slice(edit.from, edit.to) !== edit.insert,
    );
    if (!effective.length) return false;
    this.undoManager.stopCapturing();
    this.doc.transact(() => {
      for (const edit of [...effective].sort((a, b) => b.from - a.from)) {
        if (edit.to > edit.from)
          this.text.delete(edit.from, edit.to - edit.from);
        if (edit.insert) this.text.insert(edit.from, edit.insert);
      }
    });
    this.undoManager.stopCapturing();
    return true;
  }

  private acknowledge(localRevision: number) {
    this.acknowledgedRevision = Math.max(
      this.acknowledgedRevision,
      localRevision,
    );
    if (this.acknowledgedRevision !== this.localRevision) return;
    removeMarkers(this.markers);
    this.markers.clear();
  }

  /** Whether this browser has edits the server may still be missing. */
  hasPendingEdits() {
    return (
      !this.stopped &&
      this.status.canWrite &&
      this.localRevision !== this.acknowledgedRevision
    );
  }

  /** The object holding exactly this text, or undefined when not known. */
  savedAs() {
    return this.revision === this.savedRevision
      ? this.savedObjectKey
      : undefined;
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
      this.saves.set(id, {
        resolve,
        reject,
        timer,
        revision: this.revision,
        localRevision: this.localRevision,
      });
      // While synchronized, every local update has already been sent on this
      // ordered socket, so the server needs no payload to persist the file.
      this.send({ type: "save", id });
    });
  }

  whenConnected() {
    return this.when(
      ({ connected, ready }) => connected && ready,
      "Wait for project files to synchronize before exporting or compiling.",
    );
  }

  /** Resolves once the text is loaded, from the server or the offline cache. */
  whenReady() {
    return this.when(
      ({ ready }) => ready,
      "Wait for this file to synchronize before editing.",
    );
  }

  private when(check: (status: FileStatus) => boolean, message: string) {
    if (!this.destroyed && check(this.status)) return Promise.resolve();
    if (this.stopped) return Promise.reject(new Error(this.stopReason()));
    return new Promise<void>((resolve, reject) => {
      const settle = () => {
        clearTimeout(timer);
        unsubscribe();
        this.waiting.delete(fail);
      };
      const fail = (error: Error) => {
        settle();
        reject(error);
      };
      const timer = setTimeout(() => fail(new Error(message)), 10_000);
      const unsubscribe = this.subscribe(() => {
        if (!check(this.status)) return;
        settle();
        resolve();
      });
      this.waiting.add(fail);
    });
  }

  private stopReason() {
    return this.destroyed ? "This file was closed." : "This file was deleted.";
  }

  /** Nothing can become ready or connected any more. */
  private stopWaiting() {
    const reason = this.stopReason();
    for (const fail of this.waiting) fail(new Error(reason));
  }

  retire() {
    if (this.stopped) return;
    this.stopped = true;
    this.disconnect();
    this.stopWaiting();
    this.setStatus({
      canWrite: false,
      error:
        "This file was deleted. Your local text is still available to copy.",
    });
  }

  destroy() {
    if (this.destroyed) return;
    this.stopped = true;
    this.destroyed = true;
    // Tells the room before the socket closes.
    this.awareness.setLocalState(null);
    if (!this.options.connection) {
      window.removeEventListener("online", this.online);
      window.removeEventListener("offline", this.offline);
    }
    clearTimeout(this.reconnect);
    clearInterval(this.heartbeat);
    this.detach();
    this.synchronized = false;
    this.status = {
      ...this.status,
      connected: false,
      canWrite: false,
      people: [],
    };
    for (const pending of this.saves.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Project closed"));
    }
    this.saves.clear();
    this.stopWaiting();
    this.awareness.destroy();
    this.undoManager.destroy();
    this.doc.off("update", this.documentChanged);
    void this.persistence?.destroy();
    this.listeners.clear();
    this.doc.destroy();
  }
}
