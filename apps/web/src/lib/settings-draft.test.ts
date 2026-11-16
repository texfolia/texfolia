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
  });
});
test("external changes leave an untouched draft clean and preserve touched shortcuts", () => {
  const current = {
    ...defaultSettings,
    editor: { fontSize: 18, wrapLines: false },
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
test("project reloads update untouched values and preserve a formatting draft", () => {
  const previous = { indent: 2, wrap: true, width: 80 };
  const current = { indent: 4, wrap: false, width: 100 };
  expect(rebaseFormattingDraft(previous, previous, current)).toEqual(current);
  expect(
    rebaseFormattingDraft({ ...previous, width: 120 }, previous, current),
  ).toEqual({ ...current, width: 120 });
});
