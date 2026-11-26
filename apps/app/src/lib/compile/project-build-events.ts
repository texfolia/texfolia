import { buildSnapshotSchema, type BuildSnapshot } from "@texfolia/contracts";
import { z } from "zod";

const metadataEventSchema = z.object({
  type: z.literal("metadata"),
  version: z.number().int().nonnegative(),
});

export type BuildEvent =
  | { kind: "snapshot"; snapshot: BuildSnapshot }
  | { kind: "metadata"; version: number }
  | { kind: "reconnected" }
  | { kind: "access-revoked" }
  | { kind: "disconnected" };

type BuildSocket = Pick<
  WebSocket,
  "close" | "onclose" | "onmessage" | "onopen" | "readyState" | "send"
>;

const pingMs = 15_000;
const silentMs = 45_000;
const maxRetryMs = 30_000;
const accessRevokedCloseCode = 1008;

// Follows a project's builds and metadata invalidations over one WebSocket,
// reconnecting until closed. The server sends the current build snapshot and
// metadata version on every connect.
export class ProjectBuildEvents {
  private socket: BuildSocket | undefined;
  private reconnect: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private attempts = 0;
  private closed = false;
  private listeners = new Set<(event: BuildEvent) => void>();
  private snapshot: BuildSnapshot | null = null;
  private metadataVersion: number | null = null;
  private hasConnected = false;
  private disconnected = false;
  private url: string;

  constructor(
    projectId: string,
    private onSnapshot?: (snapshot: BuildSnapshot) => void,
    private createSocket: (url: string) => BuildSocket = (url) => {
      const resolved = new URL(url, window.location.href);
      resolved.protocol = resolved.protocol === "https:" ? "wss:" : "ws:";
      return new WebSocket(resolved);
    },
  ) {
    this.url = `/api/compile/${encodeURIComponent(projectId)}?events=1`;
    globalThis.addEventListener?.("online", this.online);
    this.connect();
  }

  private emit(event: BuildEvent) {
    for (const listener of this.listeners) listener(event);
  }

  private connect() {
    const socket = this.createSocket(this.url);
    this.socket = socket;
    let heardAt = Date.now();
    this.heartbeat = setInterval(() => {
      if (Date.now() - heardAt > silentMs) this.lost(socket);
      else if (socket.readyState === 1) socket.send("ping");
    }, pingMs);
    // The server answers pings without waking. A peer that never sends anything
    // may also not be told when the server closes the socket.
    socket.onopen = () => {
      if (this.socket !== socket) return;
      socket.send("ping");
      const reconnected = this.hasConnected && this.disconnected;
      this.hasConnected = true;
      this.attempts = 0;
      this.disconnected = false;
      if (reconnected) this.emit({ kind: "reconnected" });
    };
    socket.onmessage = (event: MessageEvent<unknown>) => {
      if (this.socket !== socket) return;
      heardAt = Date.now();
      if (event.data !== "pong") this.receive(event.data);
    };
    socket.onclose = (event?: { code?: number }) => {
      if (this.socket !== socket) return;
      if (event?.code === accessRevokedCloseCode)
        this.emit({ kind: "access-revoked" });
      this.lost(socket);
    };
  }

  private receive(data: unknown) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(data));
    } catch {
      return;
    }
    const metadata = metadataEventSchema.safeParse(parsed);
    if (metadata.success) {
      this.attempts = 0;
      this.disconnected = false;
      if (
        this.metadataVersion !== null &&
        metadata.data.version <= this.metadataVersion
      )
        return;
      this.metadataVersion = metadata.data.version;
      this.emit({ kind: "metadata", version: metadata.data.version });
      return;
    }
    const result = buildSnapshotSchema.safeParse(parsed);
    if (!result.success) return;
    const snapshot = result.data;
    this.attempts = 0;
    this.disconnected = false;
    const previous = this.snapshot;
    if (previous && snapshot.revision < previous.revision) return;
    if (
      previous?.current &&
      snapshot.current?.id === previous.current.id &&
      (snapshot.current.revision < previous.current.revision ||
        (["queued", "running"].includes(snapshot.current.status) &&
          ["succeeded", "failed"].includes(previous.current.status)))
    )
      return;
    this.snapshot = snapshot;
    this.onSnapshot?.(snapshot);
    this.emit({ kind: "snapshot", snapshot });
  }

  private lost(socket: BuildSocket) {
    if (this.socket !== socket) return;
    this.socket = undefined;
    clearInterval(this.heartbeat);
    socket.close();
    if (this.closed) return;
    this.reconnect = setTimeout(
      () => this.connect(),
      Math.min(maxRetryMs, 250 * 2 ** this.attempts++) + Math.random() * 250,
    );
    if (this.disconnected) return;
    this.disconnected = true;
    this.emit({ kind: "disconnected" });
  }

  private online = () => {
    if (this.socket || this.closed) return;
    clearTimeout(this.reconnect);
    this.connect();
  };

  subscribe(listener: (event: BuildEvent) => void) {
    this.listeners.add(listener);
    if (this.snapshot) listener({ kind: "snapshot", snapshot: this.snapshot });
    if (this.metadataVersion !== null)
      listener({ kind: "metadata", version: this.metadataVersion });
    if (this.disconnected) listener({ kind: "disconnected" });
    return () => this.listeners.delete(listener);
  }

  close() {
    this.closed = true;
    globalThis.removeEventListener?.("online", this.online);
    clearTimeout(this.reconnect);
    clearInterval(this.heartbeat);
    this.socket?.close();
    this.socket = undefined;
    this.listeners.clear();
  }
}
