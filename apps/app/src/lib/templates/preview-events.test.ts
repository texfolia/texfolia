import { expect, test } from "bun:test";

import {
  queuedTemplatePreviews,
  subscribeTemplatePreviews,
  type PreviewEventSource,
} from "./index";

class FakeEventSource implements PreviewEventSource {
  onmessage: ((event: MessageEvent) => unknown) | null = null;
  closed = false;

  constructor(readonly url: string) {}

  emit(data: string) {
    this.onmessage?.({ data } as MessageEvent);
  }

  close() {
    this.closed = true;
  }
}

test("selects at most four queued previews", () => {
  const templates = Array.from({ length: 6 }, (_, index) => ({
    id: String(index),
    previewStatus: index === 0 ? ("ready" as const) : ("queued" as const),
  }));
  expect(queuedTemplatePreviews(templates)).toEqual(["1", "2", "3", "4"]);
  expect(
    queuedTemplatePreviews([{ id: "a", previewStatus: "failed" }]),
  ).toEqual([]);
});

test("subscribes to preview events and notifies when ready or failed", () => {
  const sources = new Map<string, FakeEventSource>();
  const settled: Array<[string, "ready" | "failed"]> = [];
  const stop = subscribeTemplatePreviews({
    templateIds: ["a", "b"],
    onSettled: (id, status) => settled.push([id, status]),
    createSource: (url) => {
      const source = new FakeEventSource(url);
      sources.set(url, source);
      return source;
    },
  });

  const first = sources.get("/api/templates/a/preview?events=1");
  const second = sources.get("/api/templates/b/preview?events=1");
  expect(first).toBeDefined();
  expect(second).toBeDefined();

  // Malformed or non-terminal payloads are ignored without closing.
  first!.emit("not json");
  first!.emit(JSON.stringify({ previewStatus: "queued" }));
  expect(settled).toEqual([]);
  expect(first!.closed).toBe(false);

  first!.emit(JSON.stringify({ previewStatus: "ready" }));
  expect(settled).toEqual([["a", "ready"]]);
  expect(first!.closed).toBe(true);
  expect(second!.closed).toBe(false);

  second!.emit(JSON.stringify({ previewStatus: "failed" }));
  expect(settled).toEqual([
    ["a", "ready"],
    ["b", "failed"],
  ]);
  expect(second!.closed).toBe(true);

  stop();
});

test("stopping closes all active event sources and suppresses late events", () => {
  const sources: FakeEventSource[] = [];
  const settled: string[] = [];
  const stop = subscribeTemplatePreviews({
    templateIds: ["a", "b"],
    onSettled: (id) => settled.push(id),
    createSource: (url) => {
      const source = new FakeEventSource(url);
      sources.push(source);
      return source;
    },
  });

  stop();
  expect(sources.every((source) => source.closed)).toBe(true);
  sources[0]!.emit(JSON.stringify({ previewStatus: "ready" }));
  expect(settled).toEqual([]);
});
