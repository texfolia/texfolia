import { expect, test } from "bun:test";

import { rebaseFormattingDraft, rebaseUserDraft } from "./settings-draft";
import { defaultSettings } from "./settings.schema";

test("an immediate Wrap change preserves an unapplied font edit", () => {
  const draft = {
    ...defaultSettings,
    editor: { ...defaultSettings.editor, fontSize: 20 },
  };
  const current = {
    ...defaultSettings,
    editor: { ...defaultSettings.editor, wrapLines: false },
  };
  expect(rebaseUserDraft(draft, defaultSettings, current).editor).toEqual({
    fontSize: 20,
    wrapLines: false,
    keymap: "default",
  });
});
test("external changes leave an untouched draft clean and preserve touched shortcuts", () => {
  const current = {
    ...defaultSettings,
    editor: { fontSize: 18, wrapLines: false, keymap: "emacs" as const },
    shortcuts: { ...defaultSettings.shortcuts, save: "Mod+Shift+S" },
  };
  expect(rebaseUserDraft(defaultSettings, defaultSettings, current)).toEqual(
    current,
  );
  const draft = {
    ...defaultSettings,
    shortcuts: { ...defaultSettings.shortcuts, bold: "Mod+Shift+J" },
  };
  expect(rebaseUserDraft(draft, defaultSettings, current).shortcuts).toEqual({
    ...current.shortcuts,
    bold: "Mod+Shift+J",
  });
});
test("an unapplied keymap choice survives an external font change", () => {
  const draft = {
    ...defaultSettings,
    editor: { ...defaultSettings.editor, keymap: "vim" as const },
  };
  const current = {
    ...defaultSettings,
    editor: { ...defaultSettings.editor, fontSize: 16 },
  };
  expect(rebaseUserDraft(draft, defaultSettings, current).editor).toEqual({
    fontSize: 16,
    wrapLines: true,
    keymap: "vim",
  });
});
test("project reloads update untouched values and preserve a formatting draft", () => {
  const previous = { indent: 2, wrap: true, width: 80 };
  const current = { indent: 4, wrap: false, width: 100 };
  expect(rebaseFormattingDraft(previous, previous, current)).toEqual(current);
  expect(
    rebaseFormattingDraft({ ...previous, width: 120 }, previous, current),
  ).toEqual({ ...current, width: 120 });
});
test("compile on save follows external changes unless the draft changed it", () => {
  const current = {
    ...defaultSettings,
    compile: { onSave: false, afterIdle: 0 as const },
  };
  expect(
    rebaseUserDraft(defaultSettings, defaultSettings, current).compile,
  ).toEqual({ onSave: false, afterIdle: 0 });
  const draft = {
    ...current,
    compile: { onSave: true, afterIdle: 0 as const },
  };
  expect(rebaseUserDraft(draft, current, current).compile).toEqual({
    onSave: true,
    afterIdle: 0,
  });
});
test("auto-compile delay rebases independently of compile on save", () => {
  const external = {
    ...defaultSettings,
    compile: { onSave: false, afterIdle: 2 as const },
  };
  expect(
    rebaseUserDraft(defaultSettings, defaultSettings, external).compile,
  ).toEqual({ onSave: false, afterIdle: 2 });
  const draft = {
    ...defaultSettings,
    compile: { onSave: true, afterIdle: 5 as const },
  };
  expect(rebaseUserDraft(draft, defaultSettings, external).compile).toEqual({
    onSave: false,
    afterIdle: 5,
  });
});
