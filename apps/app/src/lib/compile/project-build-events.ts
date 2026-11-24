import { buildSnapshotSchema, type BuildSnapshot } from "@texfolia/contracts";

type BuildEvent =
  | { kind: "snapshot"; snapshot: BuildSnapshot }
  | { kind: "disconnected" };

type BuildSocket = Pick<
  WebSocket,
  "close" | "onclose" | "onmessage" | "onopen" | "readyState" | "send"
>;

const pingMs = 15_000;
const silentMs = 45_000;
const maxRetryMs = 30_000;

// Follows a project's builds over a WebSocket, reconnecting until closed. The
// server sends the current snapshot on every connect.
export class ProjectBuildEvents {
  private socket: BuildSocket | undefined;
  private reconnect: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private attempts = 0;
  private closed = false;
  private listeners = new Set<(event: BuildEvent) => void>();
  private snapshot: BuildSnapshot | null = null;
  private disconnected = false;
  private url: string;

  constructor(
    projectId: string,
    private onSnapshot: (snapshot: BuildSnapshot) => void,
    // Lets a caller add credentials, such as a share token, to the stream URL.
    decorateUrl: (url: string) => string = (url) => url,
    private createSocket: (url: string) => BuildSocket = (url) => {
      const resolved = new URL(url, window.location.href);
      resolved.protocol = resolved.protocol === "https:" ? "wss:" : "ws:";
      return new WebSocket(resolved);
    },
  ) {
    this.url = decorateUrl(
      `/api/compile/${encodeURIComponent(projectId)}?events=1`,
    );
    globalThis.addEventListener?.("online", this.online);
    this.connect();
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
    socket.onopen = () => socket.send("ping");
    socket.onmessage = (event: MessageEvent<unknown>) => {
      if (this.socket !== socket) return;
      heardAt = Date.now();
      if (event.data !== "pong") this.receive(event.data);
    };
    socket.onclose = () => this.lost(socket);
  }

  private receive(data: unknown) {
    let snapshot: BuildSnapshot;
    try {
      snapshot = buildSnapshotSchema.parse(JSON.parse(String(data)));
    } catch {
      return;
    }
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
    this.onSnapshot(snapshot);
    for (const listener of this.listeners)
      listener({ kind: "snapshot", snapshot });
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
    for (const listener of this.listeners) listener({ kind: "disconnected" });
  }

  private online = () => {
    if (this.socket || this.closed) return;
    clearTimeout(this.reconnect);
    this.connect();
  };

  subscribe(listener: (event: BuildEvent) => void) {
    this.listeners.add(listener);
    if (this.snapshot) listener({ kind: "snapshot", snapshot: this.snapshot });
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
