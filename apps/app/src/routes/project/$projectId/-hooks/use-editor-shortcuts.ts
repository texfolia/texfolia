import type { EditorView, ReactCodeMirrorRef } from "@uiw/react-codemirror";
import type { RefObject } from "react";

import {
  applyLatexHeading,
  headingCommands,
  toggleLatexCommand,
} from "#/features/editor/latex/editor-commands";
import { useAppShortcut } from "#/providers/shortcuts-provider";

/**
 * Binds document-level LaTeX, formatting, and Markdown preview shortcuts to
 * the editor container.
 */
export function useEditorShortcuts({
  container,
  editor,
  isLatex,
  isMarkdown,
  canFormat,
  readOnly,
  format,
  onOpenPreview,
}: {
  container: RefObject<HTMLDivElement | null>;
  editor: RefObject<ReactCodeMirrorRef | null>;
  isLatex: boolean;
  isMarkdown: boolean;
  canFormat: boolean;
  readOnly: boolean;
  format: (view: EditorView) => void;
  onOpenPreview?: () => void;
}) {
  useAppShortcut("markdown", () => onOpenPreview?.(), {
    target: container,
    enabled: isMarkdown && !!onOpenPreview,
  });
  useAppShortcut(
    "bold",
    () => {
      const view = editor.current?.view;
      if (view) toggleLatexCommand("textbf")(view);
    },
    { target: container, enabled: isLatex && !readOnly },
  );
  useAppShortcut(
    "italic",
    () => {
      const view = editor.current?.view;
      if (view) toggleLatexCommand("textit")(view);
    },
    { target: container, enabled: isLatex && !readOnly },
  );
  useAppShortcut(
    "underline",
    () => {
      const view = editor.current?.view;
      if (view) toggleLatexCommand("underline")(view);
    },
    { target: container, enabled: isLatex && !readOnly },
  );
  useAppShortcut(
    "format",
    () => {
      const view = editor.current?.view;
      if (view) format(view);
    },
    { target: container, enabled: canFormat && !readOnly },
  );
  const heading = (level: number) => {
    const view = editor.current?.view;
    const command = headingCommands[level];
    if (view && command !== undefined) applyLatexHeading(command)(view);
  };
  useAppShortcut("heading0", () => heading(0), {
    target: container,
    enabled: isLatex && !readOnly,
  });
  useAppShortcut("heading1", () => heading(1), {
    target: container,
    enabled: isLatex && !readOnly,
  });
  useAppShortcut("heading2", () => heading(2), {
    target: container,
    enabled: isLatex && !readOnly,
  });
  useAppShortcut("heading3", () => heading(3), {
    target: container,
    enabled: isLatex && !readOnly,
  });
  useAppShortcut("heading4", () => heading(4), {
    target: container,
    enabled: isLatex && !readOnly,
  });
  useAppShortcut("heading5", () => heading(5), {
    target: container,
    enabled: isLatex && !readOnly,
  });
  useAppShortcut("heading6", () => heading(6), {
    target: container,
    enabled: isLatex && !readOnly,
  });
}
