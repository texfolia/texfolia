import { describe, expect, test } from "bun:test";

import { ProjectBuildEvents, type BuildEvent } from "./project-build-events";

class FakeSocket {
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onclose: ((event?: { code?: number }) => void) | null = null;

  open() {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(data: unknown) {
    this.onmessage?.({ data } as MessageEvent<unknown>);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code = 1000) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

describe("ProjectBuildEvents", () => {
  test("delivers monotonic metadata events alongside build snapshots", () => {
    const sockets: FakeSocket[] = [];
    const snapshots: number[] = [];
    const received: BuildEvent[] = [];
    const events = new ProjectBuildEvents(
      "project-1",
      (snapshot) => snapshots.push(snapshot.revision),
      () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    );
    events.subscribe((event) => received.push(event));

    const socket = sockets[0];
    expect(socket).toBeDefined();
    socket?.open();
    socket?.receive(
      JSON.stringify({
        revision: 1,
        current: null,
        latestBuild: null,
        stale: false,
        artifacts: null,
      }),
    );
    socket?.receive(JSON.stringify({ type: "metadata", version: 3 }));
    // Duplicate and older versions are ignored.
    socket?.receive(JSON.stringify({ type: "metadata", version: 3 }));
    socket?.receive(JSON.stringify({ type: "metadata", version: 2 }));
    socket?.receive(JSON.stringify({ type: "metadata", version: 4 }));

    expect(snapshots).toEqual([1]);
    expect(
      received
        .filter((event) => event.kind === "metadata")
        .map((event) => event.version),
    ).toEqual([3, 4]);

    // Late subscribers receive the latest snapshot and metadata version.
    const late: BuildEvent[] = [];
    events.subscribe((event) => late.push(event));
    expect(late.map((event) => event.kind)).toEqual(["snapshot", "metadata"]);

    events.close();
  });

  test("emits access-revoked on close code 1008 and reconnected after reconnect", async () => {
    const sockets: FakeSocket[] = [];
    const received: BuildEvent["kind"][] = [];
    const events = new ProjectBuildEvents("project-2", undefined, () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    });
    events.subscribe((event) => received.push(event.kind));

    const first = sockets[0];
    first?.open();
    expect(received).toEqual([]);

    // Policy violation close notifies listeners that access was revoked.
    first?.close(1008);
    expect(received).toEqual(["access-revoked", "disconnected"]);

    // Wait for automatic reconnect to open a second socket.
    await Bun.sleep(600);
    const second = sockets[1];
    expect(second).toBeDefined();
    second?.open();
    expect(received).toEqual(["access-revoked", "disconnected", "reconnected"]);

    // Normal close does not emit access-revoked.
    second?.close(1006);
    expect(received).toEqual([
      "access-revoked",
      "disconnected",
      "reconnected",
      "disconnected",
    ]);

    events.close();
  });

  test("delivers single-thread comment push events without triggering metadata refresh", () => {
    const sockets: FakeSocket[] = [];
    const received: BuildEvent[] = [];
    const events = new ProjectBuildEvents("project-3", undefined, () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    });
    events.subscribe((event) => received.push(event));

    const socket = sockets[0];
    socket?.open();
    socket?.receive(JSON.stringify({ type: "comment", threadId: "thread-1" }));
    socket?.receive(JSON.stringify({ type: "comment", threadId: "thread-2" }));

    expect(received).toEqual([
      { kind: "comment", threadId: "thread-1" },
      { kind: "comment", threadId: "thread-2" },
    ]);

    // Comment events are not replayed to late subscribers.
    const late: BuildEvent[] = [];
    events.subscribe((event) => late.push(event));
    expect(late).toEqual([]);

    events.close();
  });
});
