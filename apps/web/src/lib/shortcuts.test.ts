import { expect, test } from "bun:test";

import {
  createSequenceMatcher,
  defaultShortcuts,
  eventChord,
  normalizeBinding,
  shortcutConflicts,
  shortcutMapSchema,
} from "./shortcuts";

test("defaults are complete, valid, and resolve the old sidebar/Bold conflict", () => {
  expect(shortcutMapSchema.parse(defaultShortcuts)).toEqual(defaultShortcuts);
  expect(shortcutConflicts(defaultShortcuts)).toEqual([]);
  expect(
    shortcutConflicts({ ...defaultShortcuts, sidebar: "Mod+B" }),
  ).toContainEqual({ first: "bold", second: "sidebar" });
});
test("conflicts include prefix sequences and explicit platform modifiers", () => {
  expect(
    shortcutConflicts({ ...defaultShortcuts, search: "N" }).length,
  ).toBeGreaterThan(0);
  expect(
    shortcutConflicts({ ...defaultShortcuts, sidebar: "Ctrl+B" }).length,
  ).toBeGreaterThan(0);
});
test("recorded chords normalize and malformed input is rejected", () => {
  expect(normalizeBinding("Shift+Mod+s")).toBe("Mod+Shift+S");
  expect(normalizeBinding("n p")).toBe("N P");
  expect(normalizeBinding("Mod+Mod+S")).toBeNull();
  expect(normalizeBinding("Shift")).toBeNull();
  expect(normalizeBinding("N P A B C")).toBeNull();
});
test("sequence completion, expiry, reset, and mismatches", () => {
  const matcher = createSequenceMatcher();
  const bindings = [
    { id: "newProject", binding: "N P" },
    { id: "save", binding: "Mod+S" },
  ] as const;
  expect(matcher.match("N", [...bindings], 0)).toEqual({
    action: undefined,
    pending: true,
  });
  expect(matcher.match("P", [...bindings], 200)).toEqual({
    action: "newProject",
    pending: false,
  });
  matcher.match("N", [...bindings], 400);
  expect(matcher.match("P", [...bindings], 1500).action).toBeUndefined();
  matcher.match("N", [...bindings], 1600);
  matcher.reset();
  expect(matcher.match("P", [...bindings], 1700).action).toBeUndefined();
  matcher.match("N", [...bindings], 1800);
  expect(matcher.match("Mod+S", [...bindings], 1900).action).toBe("save");
});
test("physical heading digits survive Alt keyboard layout characters", () => {
  expect(
    eventChord(
      {
        key: "¡",
        code: "Digit1",
        metaKey: true,
        ctrlKey: false,
        altKey: true,
        shiftKey: false,
      },
      true,
    ),
  ).toBe("Mod+Alt+1");
});
