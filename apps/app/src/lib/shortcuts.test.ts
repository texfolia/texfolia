import { expect, test } from "bun:test";

import {
  createSequenceMatcher,
  defaultShortcuts,
  eventChord,
  normalizeBinding,
  shortcutConflicts,
  shortcutMapSchema,
  startsWithModifier,
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
test("save defaults follow VS Code and Clean build starts unassigned", () => {
  expect(defaultShortcuts.save).toBe("Mod+S");
  expect(defaultShortcuts.saveWithoutCompiling).toBe("Mod+K S");
  expect(defaultShortcuts.compile).toBe("Mod+Shift+B");
  expect(defaultShortcuts.shortcuts).toBe("Mod+K Mod+S");
  expect(defaultShortcuts.cleanBuild).toBe("");
});
test("unassigned bindings parse and never conflict", () => {
  const map = shortcutMapSchema.parse({
    ...defaultShortcuts,
    save: " ",
    compile: "",
  });
  expect(map.save).toBe("");
  expect(shortcutConflicts(map)).toEqual([]);
});
test("modifier-led sequences run while typing; plain first keys do not", () => {
  expect(startsWithModifier("Mod+K S")).toBe(true);
  expect(startsWithModifier("Alt+Shift+F")).toBe(true);
  expect(startsWithModifier("Shift+F")).toBe(false);
  expect(startsWithModifier("N P")).toBe(false);
  expect(startsWithModifier("")).toBe(false);
});
test("Mod+K prefixes resolve to save without compiling or keyboard shortcuts", () => {
  const matcher = createSequenceMatcher();
  const bindings = [
    { id: "save", binding: "Mod+S" },
    { id: "saveWithoutCompiling", binding: "Mod+K S" },
    { id: "shortcuts", binding: "Mod+K Mod+S" },
  ] as const;
  expect(matcher.match("Mod+K", [...bindings], 0).pending).toBe(true);
  expect(matcher.pending(500)).toBe(true);
  expect(matcher.match("S", [...bindings], 500).action).toBe(
    "saveWithoutCompiling",
  );
  expect(matcher.pending(600)).toBe(false);
  matcher.match("Mod+K", [...bindings], 1000);
  expect(matcher.match("Mod+S", [...bindings], 1200).action).toBe("shortcuts");
  expect(matcher.match("Mod+S", [...bindings], 1400).action).toBe("save");
  matcher.match("Mod+K", [...bindings], 2000);
  expect(matcher.pending(3100)).toBe(false);
});
