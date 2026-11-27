import {
  decodeMultiplexServerMessage,
  encodeMultiplexClientMessage,
  multiplexCollaborationProtocol,
  peopleSearchParam,
  protocolSearchParam,
  type MultiplexClientMessage,
  type MultiplexServerMessage,
} from "./protocol";

export type CollaborationChannelHandlers = {
  onOpen: () => void;
  onMessage: (message: MultiplexServerMessage) => void;
  onDisconnect: () => void;
  onClosed?: (reason: string) => void;
};

export type CollaborationChannel = {
  send: (message: MultiplexClientMessage) => boolean;
  isOpen: () => boolean;
  detach: () => void;
};

/**
 * A single multiplexed WebSocket connection per project. Open files and the
 * scratchpad attach to it instead of each opening their own WebSocket.
 */
export class CollaborationConnection {
  private socket: WebSocket | undefined;
  private reconnect: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private pongAt = 0;
  private attempts = 0;
  private destroyed = false;
  private channels = new Map<string, CollaborationChannelHandlers>();

  constructor(private readonly projectId: string) {
    window.addEventListener("online", this.online);
    window.addEventListener("offline", this.offline);
  }

  isOpen() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  attach(
    nodeId: string,
    handlers: CollaborationChannelHandlers,
  ): CollaborationChannel {
    if (this.destroyed) {
      this.destroyed = false;
      window.addEventListener("online", this.online);
      window.addEventListener("offline", this.offline);
    }
    this.channels.set(nodeId, handlers);
    if (!this.socket && navigator.onLine !== false) this.connect();
    let detached = false;
    return {
      send: (message) => {
        if (detached || this.channels.get(nodeId) !== handlers) return false;
        return this.send(message);
      },
      isOpen: () => !detached && this.isOpen(),
      detach: () => {
        if (detached) return;
        detached = true;
        if (this.channels.get(nodeId) !== handlers) return;
        this.send({ type: "close", nodeId });
        this.channels.delete(nodeId);
        if (!this.channels.size) this.closeIdle();
      },
    };
  }

  private send(message: MultiplexClientMessage) {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(encodeMultiplexClientMessage(message));
    return true;
  }

  private offline = () => this.disconnect();

  private online = () => {
    if (this.destroyed || !this.channels.size) return;
    if (!this.socket || this.socket.readyState === WebSocket.CLOSED) {
      clearTimeout(this.reconnect);
      this.connect();
    }
  };

  private detachSocket() {
    const socket = this.socket;
    this.socket = undefined;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    socket.close();
  }

  private closeIdle() {
    clearTimeout(this.reconnect);
    clearInterval(this.heartbeat);
    this.detachSocket();
    this.attempts = 0;
  }

  private disconnect() {
    this.detachSocket();
    clearInterval(this.heartbeat);
    for (const handlers of this.channels.values()) handlers.onDisconnect();
    clearTimeout(this.reconnect);
    if (!this.destroyed && this.channels.size && navigator.onLine !== false)
      this.reconnect = setTimeout(
        () => this.connect(),
        Math.min(10_000, 250 * 2 ** this.attempts++) + Math.random() * 250,
      );
  }

  private connect() {
    if (this.destroyed || this.socket || !this.channels.size) return;
    const url = new URL(
      `/api/collaboration/${this.projectId}`,
      window.location.href,
    );
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set(protocolSearchParam, multiplexCollaborationProtocol);
    url.searchParams.set(peopleSearchParam, "1");
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.pongAt = Date.now();
      this.attempts = 0;
      for (const handlers of this.channels.values()) handlers.onOpen();
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
        const data = decodeMultiplexServerMessage(event.data);
        if (data.type === "people") {
          for (const handlers of this.channels.values())
            handlers.onMessage(data);
          return;
        }
        if (data.type === "closed") {
          this.channels.get(data.nodeId)?.onClosed?.(data.reason);
          return;
        }
        if (data.type === "error" && !data.nodeId) {
          for (const handlers of this.channels.values())
            handlers.onMessage(data);
          return;
        }
        if (data.nodeId) this.channels.get(data.nodeId)?.onMessage(data);
      } catch {
        for (const handlers of this.channels.values())
          handlers.onMessage({
            type: "error",
            message: "Could not synchronize this file. Reconnect to try again.",
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

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    window.removeEventListener("online", this.online);
    window.removeEventListener("offline", this.offline);
    clearTimeout(this.reconnect);
    clearInterval(this.heartbeat);
    this.detachSocket();
    this.channels.clear();
  }
}
