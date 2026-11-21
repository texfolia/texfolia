import type { FormatSettings } from "./latex/format";
import { settingsSchema, type Settings } from "./settings.schema";
import { shortcutIds } from "./shortcuts";

export function rebaseUserDraft(
  draft: Settings,
  previous: Settings,
  current: Settings,
): Settings {
  return settingsSchema.parse({
    ...current,
    editor: {
      fontSize:
        draft.editor.fontSize === previous.editor.fontSize
          ? current.editor.fontSize
          : draft.editor.fontSize,
      wrapLines:
        draft.editor.wrapLines === previous.editor.wrapLines
          ? current.editor.wrapLines
          : draft.editor.wrapLines,
    },
    compile: {
      onSave:
        draft.compile.onSave === previous.compile.onSave
          ? current.compile.onSave
          : draft.compile.onSave,
      afterIdle:
        draft.compile.afterIdle === previous.compile.afterIdle
          ? current.compile.afterIdle
          : draft.compile.afterIdle,
    },
    spelling:
      JSON.stringify(draft.spelling) === JSON.stringify(previous.spelling)
        ? current.spelling
        : draft.spelling,
    shortcuts: Object.fromEntries(
      shortcutIds.map((action) => [
        action,
        draft.shortcuts[action] === previous.shortcuts[action]
          ? current.shortcuts[action]
          : draft.shortcuts[action],
      ]),
    ),
  });
}
export function rebaseFormattingDraft(
  draft: FormatSettings,
  previous: FormatSettings,
  current: FormatSettings,
): FormatSettings {
  return {
    indent: draft.indent === previous.indent ? current.indent : draft.indent,
    wrap: draft.wrap === previous.wrap ? current.wrap : draft.wrap,
    width: draft.width === previous.width ? current.width : draft.width,
  };
}
