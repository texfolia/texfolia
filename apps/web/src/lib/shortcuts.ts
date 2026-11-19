import { z } from "zod";

// Defaults follow VS Code unless a binding would take over an important
// browser or editor function. An empty binding leaves the action unassigned.
export const shortcutActions = {
  settings: { label: "Settings", binding: "Mod+,", typing: true },
  shortcuts: {
    label: "Keyboard shortcuts",
    binding: "Mod+K Mod+S",
    typing: true,
  },
  save: { label: "Save", binding: "Mod+S", typing: true },
  saveWithoutCompiling: {
    label: "Save without compiling",
    binding: "Mod+K S",
    typing: true,
  },
  compile: { label: "Save & compile", binding: "Mod+Shift+B", typing: true },
  cleanBuild: { label: "Clean build", binding: "", typing: true },
  bold: { label: "Bold", binding: "Mod+B", typing: true },
  italic: { label: "Italic", binding: "Mod+I", typing: true },
  underline: { label: "Underline", binding: "Mod+U", typing: true },
  heading0: { label: "Normal text", binding: "Mod+Alt+0", typing: true },
  heading1: { label: "Heading 1", binding: "Mod+Alt+1", typing: true },
  heading2: { label: "Heading 2", binding: "Mod+Alt+2", typing: true },
  heading3: { label: "Heading 3", binding: "Mod+Alt+3", typing: true },
  heading4: { label: "Heading 4", binding: "Mod+Alt+4", typing: true },
  heading5: { label: "Heading 5", binding: "Mod+Alt+5", typing: true },
  heading6: { label: "Heading 6", binding: "Mod+Alt+6", typing: true },
  format: { label: "Format document", binding: "Alt+Shift+F", typing: true },
  markdown: {
    label: "Open Markdown preview",
    binding: "Mod+Shift+V",
    typing: true,
  },
  nextTab: { label: "Next editor tab", binding: "Ctrl+PageDown", typing: true },
  previousTab: {
    label: "Previous editor tab",
    binding: "Ctrl+PageUp",
    typing: true,
  },
  sidebar: { label: "Toggle sidebar", binding: "Mod+Alt+B", typing: false },
  panel: { label: "Toggle panel", binding: "Mod+J", typing: true },
  search: { label: "Search projects", binding: "Mod+P", typing: true },
  projectSearch: {
    label: "Search in project",
    binding: "Mod+Shift+F",
    typing: true,
  },
  newProject: { label: "New project", binding: "N P", typing: false },
} as const;
export type ShortcutAction = keyof typeof shortcutActions;
export const shortcutIds = Object.keys(shortcutActions).filter(
  (key): key is ShortcutAction => Object.hasOwn(shortcutActions, key),
);
export const shortcutActionSchema = z.enum(shortcutIds);

const modifiers = ["Mod", "Ctrl", "Meta", "Alt", "Shift"];
export function normalizeBinding(value: string): string | null {
  const chords = value.trim().split(/\s+/);
  if (!value.trim() || chords.length > 4) return null;
  const result: string[] = [];
  for (const chord of chords) {
    const parts = chord.split("+");
    const key = parts.pop();
    if (
      !key ||
      !/^(?:[a-z0-9,./;='[\]\\`-]|PageDown|PageUp|Enter|Space|Backspace|Delete|Arrow(?:Up|Down|Left|Right)|F(?:[1-9]|1[0-9]|2[0-4]))$/i.test(
        key,
      )
    )
      return null;
    if (
      parts.some((part) => !modifiers.includes(part)) ||
      new Set(parts).size !== parts.length
    )
      return null;
    result.push(
      [
        ...modifiers.filter((part) => parts.includes(part)),
        key.length === 1 ? key.toUpperCase() : key,
      ].join("+"),
    );
  }
  return result.join(" ");
}
export const bindingSchema = z.string().transform((value, context) => {
  if (!value.trim()) return "";
  const binding = normalizeBinding(value);
  if (binding) return binding;
  context.addIssue({
    code: "custom",
    message: "Record a key chord or a sequence of up to four keys.",
  });
  return z.NEVER;
});
export const shortcutMapSchema = z.record(shortcutActionSchema, bindingSchema);
export type ShortcutMap = z.infer<typeof shortcutMapSchema>;
export const defaultShortcuts = shortcutMapSchema.parse(
  Object.fromEntries(
    shortcutIds.map((id) => [id, shortcutActions[id].binding]),
  ),
);

export function shortcutConflicts(map: ShortcutMap) {
  const conflicts: { first: ShortcutAction; second: ShortcutAction }[] = [];
  for (const [index, first] of shortcutIds.entries()) {
    for (const second of shortcutIds.slice(index + 1)) {
      if (!map[first] || !map[second]) continue;
      // Mod and explicit Ctrl/Meta can resolve to the same physical key.
      const variants = (binding: string) => [
        binding.replaceAll("Mod", "Ctrl"),
        binding.replaceAll("Mod", "Meta"),
      ];
      if (
        variants(map[first]).some((a) =>
          variants(map[second]).some(
            (b) => a === b || a.startsWith(`${b} `) || b.startsWith(`${a} `),
          ),
        )
      )
        conflicts.push({ first, second });
    }
  }
  return conflicts;
}

export function eventChord(
  event: Pick<
    KeyboardEvent,
    "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
  >,
  mac: boolean,
): string | null {
  if (
    ["Control", "Meta", "Alt", "Shift", "Dead", "Unidentified"].includes(
      event.key,
    )
  )
    return null;
  let key = event.code.startsWith("Digit")
    ? event.code.slice(5)
    : event.code.startsWith("Key")
      ? event.code.slice(3)
      : event.key === " "
        ? "Space"
        : event.key;
  if (key.length === 1) key = key.toUpperCase();
  return [
    mac ? event.metaKey && "Mod" : event.ctrlKey && "Mod",
    mac ? event.ctrlKey && "Ctrl" : event.metaKey && "Meta",
    event.altKey && "Alt",
    event.shiftKey && "Shift",
    key,
  ]
    .filter(Boolean)
    .join("+");
}
// Bindings that start with Ctrl, Meta, or Alt can run while typing, including
// sequences such as Mod+K S; unmodified first keys belong to the text.
export function startsWithModifier(binding: string) {
  return /^(?:Mod|Ctrl|Meta|Alt)\+/.test(binding);
}
export function isTypingTarget(target: EventTarget | null) {
  return (
    target instanceof Element &&
    !!target.closest(
      "input, textarea, select, [contenteditable=true], .cm-editor, [role=textbox]",
    )
  );
}

export function createSequenceMatcher() {
  let prefix = "";
  let lastKeyAt = 0;
  return {
    reset() {
      prefix = "";
    },
    pending(now: number) {
      return !!prefix && now - lastKeyAt <= 1000;
    },
    match(
      chord: string,
      bindings: { id: ShortcutAction; binding: string }[],
      now: number,
    ) {
      if (now - lastKeyAt > 1000) prefix = "";
      lastKeyAt = now;
      const candidate = prefix ? `${prefix} ${chord}` : chord;
      let matches = bindings.filter(
        ({ binding }) =>
          binding === candidate || binding.startsWith(`${candidate} `),
      );
      if (!matches.length && prefix)
        matches = bindings.filter(
          ({ binding }) => binding === chord || binding.startsWith(`${chord} `),
        );
      const complete = matches.find(
        ({ binding }) => binding === candidate || binding === chord,
      );
      prefix = complete
        ? ""
        : matches.length
          ? matches[0]?.binding.startsWith(`${candidate} `)
            ? candidate
            : chord
          : "";
      return { action: complete?.id, pending: !!prefix };
    },
  };
}
