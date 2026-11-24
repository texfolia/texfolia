import { expect, test } from "bun:test";

import { isEditorCommandDisabled } from "./use-editor-commands";

test("blocks mutating commands in read-only mode while allowing read commands", () => {
  for (const command of [
    "undo",
    "redo",
    "format",
    "cut",
    "paste",
    "symbols",
  ] as const)
    expect(isEditorCommandDisabled(command, { readOnly: true })).toBe(true);

  for (const command of ["copy", "find", "selectAll", "wrap"] as const)
    expect(isEditorCommandDisabled(command, { readOnly: true })).toBe(false);
});

test("gates undo and redo on history depth when status is provided", () => {
  expect(
    isEditorCommandDisabled("undo", {
      readOnly: false,
      status: { undo: false, redo: true },
    }),
  ).toBe(true);
  expect(
    isEditorCommandDisabled("redo", {
      readOnly: false,
      status: { undo: false, redo: true },
    }),
  ).toBe(false);
  expect(
    isEditorCommandDisabled("undo", {
      readOnly: false,
      status: { undo: true, redo: false },
    }),
  ).toBe(false);
  expect(
    isEditorCommandDisabled("redo", {
      readOnly: false,
      status: { undo: true, redo: false },
    }),
  ).toBe(true);
});
