import { downloadFile } from "#/lib/download-file";
import { redo, redoDepth, undo, undoDepth } from "@codemirror/commands";
import { StreamLanguage } from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { openSearchPanel } from "@codemirror/search";
import CodeMirror, {
  EditorView,
  keymap,
  type ReactCodeMirrorRef,
} from "@uiw/react-codemirror";
import {
  Download,
  FolderOpen,
  Redo2,
  Search,
  Undo2,
  WrapText,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  PanelAction,
  PanelActions,
  PanelHeader,
} from "#/components/panel-header";

const latex = StreamLanguage.define(stex);
const editorTheme = EditorView.theme({
  "&": { backgroundColor: "var(--background)", color: "var(--foreground)" },
  ".cm-content, .cm-gutters": {
    fontFamily: "var(--font-mono)",
    fontSize: "13px",
  },
  ".cm-gutters": {
    backgroundColor: "var(--muted)",
    color: "var(--muted-foreground)",
    borderRight: "1px solid var(--border)",
  },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--accent)" },
  ".cm-cursor": { borderLeftColor: "var(--foreground)" },
  ".cm-scroller": { overflow: "auto" },
});

type EditorProps = {
  defaultValue?: string;
  filename?: string;
  onChange?: (value: string) => void;
};

export function Editor({
  defaultValue = "",
  filename = "main.tex",
  onChange,
}: EditorProps) {
  const editor = useRef<ReactCodeMirrorRef>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const openRequest = useRef(0);
  const [value, setValue] = useState(defaultValue);
  const [name, setName] = useState(filename);
  const [savedValue, setSavedValue] = useState(defaultValue);
  const [wrap, setWrap] = useState(true);
  const [error, setError] = useState("");
  const [status, setStatus] = useState({
    line: 1,
    column: 1,
    lines: 1,
    undo: false,
    redo: false,
  });
  const modified = value !== savedValue;

  useEffect(() => {
    if (!modified) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [modified]);

  const extensions = useMemo(
    () => [
      latex,
      editorTheme,
      ...(wrap ? [EditorView.lineWrapping] : []),
      keymap.of([
        {
          key: "Mod-s",
          run: (view) => {
            const content = view.state.doc.toString();
            downloadFile(
              new Blob([content], { type: "text/plain;charset=utf-8" }),
              name,
            );
            setSavedValue(content);
            return true;
          },
        },
      ]),
    ],
    [name, wrap],
  );

  async function openFile(file: File) {
    const request = ++openRequest.current;
    try {
      const text = await file.text();
      if (request !== openRequest.current) return;
      if (
        modified &&
        !window.confirm(
          "Replace your current source? Download it first to keep your changes.",
        )
      )
        return;
      setName(file.name);
      setSavedValue(text);
      setError("");
      const view = editor.current?.view;
      if (view)
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
          selection: { anchor: 0 },
        });
      else {
        setValue(text);
        onChange?.(text);
      }
      view?.focus();
    } catch {
      if (request === openRequest.current)
        setError("Could not read this source file. Try opening it again.");
    }
  }

  return (
    <section
      aria-label="Source editor"
      className="flex h-full min-h-0 min-w-0 flex-col bg-background"
    >
      <PanelHeader title={name}>
        <PanelActions label="Editor actions">
          <PanelAction
            label="Open source file"
            onClick={() => fileInput.current?.click()}
          >
            <FolderOpen />
          </PanelAction>
          <PanelAction
            label="Download source (⌘/Ctrl+S)"
            onClick={() => {
              downloadFile(
                new Blob([value], { type: "text/plain;charset=utf-8" }),
                name,
              );
              setSavedValue(value);
            }}
          >
            <Download />
          </PanelAction>
          <PanelAction
            label="Undo"
            disabled={!status.undo}
            onClick={() => {
              const view = editor.current?.view;
              if (view) {
                undo(view);
                view.focus();
              }
            }}
          >
            <Undo2 />
          </PanelAction>
          <PanelAction
            label="Redo"
            disabled={!status.redo}
            onClick={() => {
              const view = editor.current?.view;
              if (view) {
                redo(view);
                view.focus();
              }
            }}
          >
            <Redo2 />
          </PanelAction>
          <PanelAction
            label="Find and replace"
            onClick={() => {
              const view = editor.current?.view;
              if (view) openSearchPanel(view);
            }}
          >
            <Search />
          </PanelAction>
          <PanelAction
            label="Wrap lines"
            aria-pressed={wrap}
            onClick={() => setWrap(!wrap)}
          >
            <WrapText />
          </PanelAction>
        </PanelActions>
      </PanelHeader>
      <input
        ref={fileInput}
        type="file"
        accept=".tex,.bib,.sty,.cls,.txt,text/plain"
        className="hidden"
        aria-label="Choose source file"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void openFile(file);
        }}
      />
      {error && (
        <p role="alert" className="border-b px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}
      <CodeMirror
        ref={editor}
        value={value}
        onChange={(text) => {
          setValue(text);
          onChange?.(text);
        }}
        onUpdate={({ state }) => {
          const position = state.selection.main.head;
          const line = state.doc.lineAt(position);
          const next = {
            line: line.number,
            column: position - line.from + 1,
            lines: state.doc.lines,
            undo: undoDepth(state) > 0,
            redo: redoDepth(state) > 0,
          };
          setStatus((previous) =>
            previous.line === next.line &&
            previous.column === next.column &&
            previous.lines === next.lines &&
            previous.undo === next.undo &&
            previous.redo === next.redo
              ? previous
              : next,
          );
        }}
        extensions={extensions}
        height="100%"
        theme="none"
        placeholder="Write your LaTeX here…"
        aria-label="LaTeX source"
        className="min-h-0 flex-1 overflow-hidden [&>.cm-editor]:h-full"
      />
      <footer className="flex shrink-0 items-center justify-between gap-2 border-t px-3 py-1.5 text-xs text-muted-foreground">
        <span>
          LaTeX · {status.lines} {status.lines === 1 ? "line" : "lines"}
          {modified ? " · Modified" : ""}
        </span>
        <span>
          Ln {status.line}, Col {status.column}
        </span>
      </footer>
    </section>
  );
}
