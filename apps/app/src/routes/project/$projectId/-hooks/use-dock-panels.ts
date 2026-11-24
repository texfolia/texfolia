import type { EditorView } from "@uiw/react-codemirror";
import type { DockviewApi } from "dockview-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { scratchpadId } from "#/lib/collaboration";
import type { EditorCommand } from "#/lib/editor/editor-command";
import { projectPaths } from "#/lib/projects";
import type { ProjectNode } from "#/lib/projects/project.functions";
import {
  isEditorComponent,
  restoreWorkspaceDock,
} from "#/lib/workspace/workspace-layout";
import type { useProjectFiles } from "#/providers/project-files-provider";
import type { FileState, Workspace } from "#/providers/workspace-provider";

import type { MarkdownPreviewParams } from "../-components/markdown-preview";

export type FilePanelParams = { node: ProjectNode; preview: boolean };

export const scratchpadTitle = "Scratchpad";

const markdownId = (id: string) => `markdown:${id}`;

/**
 * The dock of editor, generated-file and preview tabs. One unpinned tab at a
 * time is a preview that the next opened file replaces, like VS Code.
 */
export function useDockPanels({
  files,
  nodes,
  paths,
  drafts,
  ready,
  updateAnalysis,
}: {
  files: ReturnType<typeof useProjectFiles>;
  nodes: ProjectNode[];
  paths: ReadonlyMap<string, string>;
  drafts: Map<string, FileState>;
  ready: boolean;
  /** Reports a file's text to the LaTeX analysis. */
  updateAnalysis: (path: string, value: string) => void;
}) {
  const api = useRef<DockviewApi | null>(null);
  const previewId = useRef<string | null>(null);
  const subscriptions = useRef<Array<{ dispose: () => void }>>([]);
  const editors = useRef(new Map<string, EditorView>());
  const commands = useRef(new Map<string, (command: EditorCommand) => void>());
  const positions = useRef(new Map<string, { line: number; column: number }>());
  const previousPaths = useRef(paths);
  // Kept apart from the drafts, which search, analysis and saving cover.
  const scratchpadSource = useRef("");
  const [activeId, setActiveId] = useState<string>();
  const [cursor, setCursor] = useState<{
    id: string;
    line: number;
    column: number;
  }>();
  const [jump, setJump] = useState<Workspace["jump"]>();
  const nodesById = useMemo(
    () => new Map(nodes.map((node) => [node.id, node])),
    [nodes],
  );
  const idsByPath = useMemo(
    () => new Map([...paths].map(([id, path]) => [path, id])),
    [paths],
  );

  const registerEditor = useCallback((id: string, view: EditorView | null) => {
    if (view) editors.current.set(id, view);
    else editors.current.delete(id);
  }, []);
  const registerCommands = useCallback(
    (id: string, run: ((command: EditorCommand) => void) | null) => {
      if (run) commands.current.set(id, run);
      else commands.current.delete(id);
    },
    [],
  );
  const reportCursor = useCallback(
    (id: string, position: { line: number; column: number }) => {
      positions.current.set(id, position);
      if (api.current?.activePanel?.id === id)
        setCursor((previous) =>
          previous?.id === id &&
          previous.line === position.line &&
          previous.column === position.column
            ? previous
            : { id, ...position },
        );
    },
    [],
  );

  const fileTitle = (node: ProjectNode) => {
    const draft = drafts.get(node.id);
    return `${node.name}${draft && draft.value !== draft.savedValue ? " ●" : ""}`;
  };
  /** Marks a file's tab when its text differs from the saved copy. */
  function refreshTitle(id: string) {
    const node = files.nodes.get(id);
    if (node) api.current?.getPanel(id)?.api.setTitle(fileTitle(node));
  }
  function showMarkdownSource(id: string, source: string) {
    api.current?.getPanel(markdownId(id))?.api.updateParameters({ source });
  }

  // Renamed or moved files update their tabs and analysis paths.
  useEffect(() => {
    if (!ready) return;
    for (const node of nodes) {
      const path = paths.get(node.id);
      if (!path || previousPaths.current.get(node.id) === path) continue;
      const draft = drafts.get(node.id);
      if (draft) updateAnalysis(path, draft.value);
      const panel = api.current?.getPanel(node.id);
      panel?.api.updateParameters({ node });
      panel?.api.setTitle(fileTitle(node));
      api.current
        ?.getPanel(markdownId(node.id))
        ?.api.setTitle(`Preview: ${node.name}`);
    }
    previousPaths.current = paths;
  }, [nodes, paths, ready, updateAnalysis, drafts]);

  useEffect(
    () => () => {
      api.current = null;
      subscriptions.current.forEach((subscription) => subscription.dispose());
    },
    [],
  );

  /** A document's current text, for its Markdown preview. */
  function sourceOf(id: string) {
    return id === scratchpadId
      ? scratchpadSource.current
      : (drafts.get(id)?.value ?? "");
  }
  function showScratchpad(source: string) {
    scratchpadSource.current = source;
    showMarkdownSource(scratchpadId, source);
  }

  function keepOpen(id: string) {
    if (previewId.current !== id) return;
    previewId.current = null;
    api.current?.getPanel(id)?.api.updateParameters({ preview: false });
  }

  function openMarkdownPreview(id: string) {
    const dock = api.current;
    const name =
      id === scratchpadId ? scratchpadTitle : nodesById.get(id)?.name;
    if (
      !dock ||
      !name ||
      (id !== scratchpadId && !/\.(?:md|markdown)$/i.test(name))
    )
      return;
    keepOpen(id);
    const existing = dock.getPanel(markdownId(id));
    if (existing) {
      existing.api.setActive();
      return;
    }
    const reference = dock.panels.find(
      (panel) => !isEditorComponent(panel.api.component),
    );
    dock.addPanel<MarkdownPreviewParams>({
      id: markdownId(id),
      component: "markdown",
      title: `Preview: ${name}`,
      params: { source: sourceOf(id) },
      position: reference
        ? { referencePanel: reference.id, direction: "within" }
        : { referencePanel: id, direction: "right" },
    });
  }

  function openFile(node: ProjectNode, permanent: boolean) {
    const created = files.createdTextSources.get(node.id);
    if (created !== undefined) {
      drafts.set(node.id, { value: created, savedValue: created });
      files.createdTextSources.delete(node.id);
      const path =
        paths.get(node.id) ??
        projectPaths([
          ...nodes.filter((existing) => existing.id !== node.id),
          node,
        ]).get(node.id);
      if (path) updateAnalysis(path, created);
    }
    const dock = api.current;
    if (!dock) return;
    const existing = dock.getPanel(node.id);
    if (existing) {
      if (permanent) keepOpen(node.id);
      existing.api.setActive();
      return;
    }
    const preview = previewId.current
      ? dock.getPanel(previewId.current)
      : undefined;
    const reference =
      preview ??
      dock.panels.find((panel) => isEditorComponent(panel.api.component));
    const previewPanel = dock.panels.find(
      (panel) => !isEditorComponent(panel.api.component),
    );
    dock.addPanel<FilePanelParams>({
      id: node.id,
      component: "editor",
      tabComponent: "file",
      title: fileTitle(node),
      params: { node, preview: !permanent },
      position: reference
        ? { referencePanel: reference.id, direction: "within" }
        : previewPanel
          ? { referencePanel: previewPanel.id, direction: "left" }
          : undefined,
    });
    if (!permanent) {
      previewId.current = node.id;
      if (preview) dock.removePanel(preview);
    }
  }

  function openScratchpad() {
    const dock = api.current;
    if (!dock) return;
    const existing = dock.getPanel(scratchpadId);
    if (existing) {
      existing.api.setActive();
      return;
    }
    const reference = dock.panels.find((panel) =>
      isEditorComponent(panel.api.component),
    );
    const previewPanel = dock.panels[0];
    dock.addPanel({
      id: scratchpadId,
      component: "scratchpad",
      tabComponent: "file",
      title: scratchpadTitle,
      params: {},
      position: reference
        ? { referencePanel: reference.id, direction: "within" }
        : previewPanel
          ? { referencePanel: previewPanel.id, direction: "left" }
          : undefined,
    });
  }

  function openGenerated(path: string, permanent = false) {
    const dock = api.current;
    if (!dock) return;
    const id = `out:${path}`;
    const existing = dock.getPanel(id);
    if (existing) {
      if (permanent) keepOpen(id);
      existing.api.setActive();
      return;
    }
    const preview = previewId.current
      ? dock.getPanel(previewId.current)
      : undefined;
    const reference =
      preview ??
      dock.panels.find(
        (panel) =>
          isEditorComponent(panel.api.component) ||
          panel.api.component === "generated",
      );
    dock.addPanel({
      id,
      component: "generated",
      tabComponent: "file",
      title: path.split("/").at(-1) ?? path,
      params: { path, preview: !permanent },
      position: reference
        ? { referencePanel: reference.id, direction: "within" }
        : undefined,
    });
    if (!permanent) {
      previewId.current = id;
      if (preview) dock.removePanel(preview);
    }
  }

  function reveal(path: string, line = 1, column?: number, length?: number) {
    const id = idsByPath.get(path);
    const node = id === undefined ? undefined : nodesById.get(id);
    if (!node) return;
    openFile(node, true);
    setJump({ id: node.id, line, column, length });
  }
  function revealRange(nodeId: string, range: { from: number; to: number }) {
    const node = nodesById.get(nodeId);
    if (!node) return;
    openFile(node, true);
    setJump({ id: node.id, line: 1, range });
  }

  function closeTabs(id: string, mode: "one" | "others" | "all" | "right") {
    const dock = api.current;
    const panel = dock?.getPanel(id);
    if (!dock || !panel) return;
    const group = [...panel.group.panels];
    const index = group.findIndex((panel) => panel.id === id);
    const targets =
      mode === "all"
        ? group
        : mode === "others"
          ? group.filter((panel) => panel.id !== id)
          : mode === "right"
            ? group.slice(index + 1)
            : [panel];
    for (const target of targets) dock.removePanel(target);
  }

  function cycleTab(direction: number) {
    const panels =
      api.current?.panels.filter((panel) =>
        isEditorComponent(panel.api.component),
      ) ?? [];
    const activePanel = api.current?.activePanel;
    const currentId =
      activePanel && isEditorComponent(activePanel.api.component)
        ? activePanel.id
        : activeId;
    const index = panels.findIndex((panel) => panel.id === currentId);
    panels[
      (index + direction + panels.length) % panels.length
    ]?.api.setActive();
  }

  /**
   * Subscribes to the dock and restores the saved layout, or opens the main
   * file when there is none.
   */
  function restore(
    dock: DockviewApi,
    saved: unknown,
    onLayoutChange: () => void,
  ) {
    subscriptions.current.forEach((subscription) => subscription.dispose());
    subscriptions.current = [
      dock.onDidActivePanelChange(({ panel }) => {
        if (
          panel &&
          (isEditorComponent(panel.api.component) ||
            panel.api.component === "generated")
        )
          setActiveId(panel.id);
        if (panel) {
          const position = positions.current.get(panel.id);
          setCursor(position ? { id: panel.id, ...position } : undefined);
        }
      }),
      dock.onDidLayoutChange(onLayoutChange),
      dock.onDidRemovePanel((panel) => {
        if (previewId.current === panel.id) previewId.current = null;
        setActiveId((previous) =>
          previous === panel.id ? undefined : previous,
        );
      }),
    ];
    const first =
      nodes.find((node) => node.kind === "text" && node.name === "main.tex") ??
      nodes.find((node) => node.kind === "text");
    if (!restoreWorkspaceDock(dock, saved, nodes) && first) {
      openFile(first, true);
      dock.getPanel(first.id)?.api.setActive();
    }
    for (const panel of dock.panels) {
      if (panel.api.component === "markdown")
        panel.api.updateParameters({
          source: sourceOf(panel.id.slice("markdown:".length)),
        });
      if (panel.params?.preview === true) {
        if (previewId.current)
          dock
            .getPanel(previewId.current)
            ?.api.updateParameters({ preview: false });
        previewId.current = panel.id;
      }
    }
  }

  return {
    api,
    connect(dock: DockviewApi) {
      api.current = dock;
    },
    activeId,
    cursor,
    jump,
    activeEditor: () => (activeId ? editors.current.get(activeId) : undefined),
    editor: (id: string) => editors.current.get(id),
    runCommand(command: EditorCommand) {
      if (activeId) commands.current.get(activeId)?.(command);
    },
    registerEditor,
    registerCommands,
    reportCursor,
    refreshTitle,
    showMarkdownSource,
    showScratchpad,
    keepOpen,
    openFile,
    openGenerated,
    openScratchpad,
    openMarkdownPreview,
    reveal,
    revealRange,
    closeTabs,
    cycleTab,
    restore,
  };
}
