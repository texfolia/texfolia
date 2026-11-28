import { expect, test } from "bun:test";

import { EditorState } from "@uiw/react-codemirror";

import {
  clipboardTargetUnchanged,
  isEditorCommandDisabled,
} from "./use-editor-commands";

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

test("cut and paste apply only where they started", () => {
  const before = EditorState.create({
    doc: "one two three",
    selection: { anchor: 4, head: 7 },
  });
  const target = (state: EditorState, isConnected = true) =>
    clipboardTargetUnchanged(before, {
      state,
      dom: { isConnected } as HTMLElement,
    });
  expect(target(before)).toBe(true);
  // The editor closed while the clipboard was waiting.
  expect(target(before, false)).toBe(false);
  // Someone else's edit moves the selection along.
  expect(
    target(before.update({ changes: { from: 0, insert: "zero " } }).state),
  ).toBe(true);
  // Someone else changed the selected text.
  expect(
    target(before.update({ changes: { from: 5, insert: "!" } }).state),
  ).toBe(false);
  // Other text was selected.
  expect(
    target(before.update({ selection: { anchor: 0, head: 3 } }).state),
  ).toBe(false);
  expect(
    target(
      EditorState.create({
        doc: "one two three",
        selection: { anchor: 4, head: 7 },
        extensions: EditorState.readOnly.of(true),
      }),
    ),
  ).toBe(false);
});
