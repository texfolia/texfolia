import { expect, test } from "bun:test";

import { maxSourceFileBytes } from "@texfolia/storage";
import * as Y from "yjs";

import { maxCollaborationBytes } from "./protocol";
import { checkUpdate, measureUsage } from "./usage";

const limitError = /exceeds its text or history limit/;

function room(text = "") {
  const doc = new Y.Doc();
  doc.getText("source").insert(0, text);
  return doc;
}

// Edits a replica of `doc` and returns only the new changes.
function edit(doc: Y.Doc, change: (replica: Y.Doc) => void) {
  const replica = new Y.Doc();
  Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc));
  const vector = Y.encodeStateVector(replica);
  change(replica);
  const update = Y.encodeStateAsUpdate(replica, vector);
  replica.destroy();
  return update;
}

test("accepts plain text edits and tracks sizes at or above the real ones", () => {
  const doc = room("hello world");
  let usage = measureUsage(doc);
  for (let i = 0; i < 200; i++) {
    const update = edit(doc, (replica) => {
      const text = replica.getText("source");
      const at = (i * 7) % (text.length + 1);
      if (i % 3 === 0 && text.length > 2) text.delete(at % text.length, 1);
      else text.insert(at, i % 2 ? "é" : "x");
    });
    usage = checkUpdate(doc, usage, update);
    Y.applyUpdate(doc, update);
    const exact = measureUsage(doc);
    expect(usage.textBytes).toBeGreaterThanOrEqual(exact.textBytes);
    expect(usage.historyBytes).toBeGreaterThanOrEqual(exact.historyBytes);
  }
});

test("does not count content the document already has", () => {
  const doc = room("existing");
  const usage = measureUsage(doc);
  expect(checkUpdate(doc, usage, Y.encodeStateAsUpdate(doc)).textBytes).toBe(
    usage.textBytes,
  );
});

test("rejects updates outside plain source text", () => {
  const doc = room("text");
  const usage = measureUsage(doc);
  for (const change of [
    (replica: Y.Doc) => replica.getMap("other").set("key", "value"),
    (replica: Y.Doc) => replica.getText("other").insert(0, "text"),
    (replica: Y.Doc) => replica.getText("source").format(0, 2, { bold: true }),
    (replica: Y.Doc) => replica.getText("source").insertEmbed(1, { x: 1 }),
    (replica: Y.Doc) =>
      replica.getText("source").insert(2, "styled", { bold: true }),
  ])
    expect(() => checkUpdate(doc, usage, edit(doc, change))).toThrow(
      limitError,
    );
  expect(doc.getText("source").toString()).toBe("text");
});

test("enforces the text limit exactly near it", () => {
  const doc = room("a".repeat(maxSourceFileBytes - 1));
  const usage = measureUsage(doc);
  expect(() =>
    checkUpdate(
      doc,
      usage,
      edit(doc, (replica) => replica.getText("source").insert(0, "bc")),
    ),
  ).toThrow(limitError);
  // A replacement fits even though its insert alone would not.
  const replace = edit(doc, (replica) => {
    const text = replica.getText("source");
    text.delete(0, 10);
    text.insert(0, "b".repeat(11));
  });
  expect(checkUpdate(doc, usage, replace)).toEqual({
    textBytes: maxSourceFileBytes,
    historyBytes: expect.any(Number),
  });
});

test("measures exactly when the running history size nears its limit", () => {
  const doc = room("text");
  const update = edit(doc, (replica) =>
    replica.getText("source").insert(0, "x"),
  );
  const usage = checkUpdate(
    doc,
    { textBytes: 4, historyBytes: maxCollaborationBytes },
    update,
  );
  Y.applyUpdate(doc, update);
  expect(usage).toEqual(measureUsage(doc));
});
