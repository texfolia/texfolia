import { expect, test } from "bun:test";

import { draftSources, FileDrafts } from "./file-drafts";

test("notifies and bumps the revision only when text changes", () => {
  const drafts = new FileDrafts();
  let notified = 0;
  const unsubscribe = drafts.subscribe(() => notified++);
  drafts.set("a", { value: "one", savedValue: "one" });
  drafts.set("a", { value: "one", savedValue: "one" });
  expect(notified).toBe(1);
  const before = drafts.getRevision();
  drafts.set("a", { value: "two", savedValue: "one" });
  expect(drafts.getRevision()).not.toBe(before);
  // Saving changes the saved text even when the live text stays.
  drafts.set("a", { value: "two", savedValue: "two" });
  expect(notified).toBe(3);
  unsubscribe();
  drafts.set("a", { value: "three", savedValue: "two" });
  expect(notified).toBe(3);
});

test("lists the live text of files that have a draft", () => {
  const drafts = new FileDrafts();
  drafts.set("a", { value: "live", savedValue: "saved" });
  expect(
    draftSources(
      new Map([
        ["a", "main.tex"],
        ["b", "logo.png"],
      ]),
      drafts,
    ),
  ).toEqual([{ nodeId: "a", path: "main.tex", text: "live" }]);
});
