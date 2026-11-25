import { type BuildSnapshot } from "@texfolia/contracts";
import type { EditorView } from "@uiw/react-codemirror";
import { createContext, type ReactNode, useContext } from "react";

import type { Comments } from "#/hooks/use-comments";
import type { CollaborativeFile } from "#/lib/collaboration/browser";
import type { EditorCommand } from "#/lib/editor/editor-command";
import type { LatexProblem } from "#/lib/editor/latex/analysis";
import type { latexCompletion } from "#/lib/editor/latex/completion";
import type { FormatSettings } from "#/lib/editor/latex/format";
import type { SyncTexIndex, SyncTexLocation } from "#/lib/editor/latex/synctex";
import type { FileDrafts } from "#/lib/workspace/file-drafts";

export type { FileState } from "#/lib/workspace/file-drafts";

/**
 * What never changes while the workspace is open: its actions, the project, and
 * the drafts. Reading it never renders again.
 */
export type WorkspaceActions = {
  projectId: string;
  /** Each file's text. Subscribe to it to show text that changes. */
  drafts: FileDrafts;
  /**
   * Connects a text file's document, or the scratchpad's, until the returned
   * function is called.
   */
  holdDocument: (id: string) => () => void;
  /** Edits a text file's collaborative document, connecting it if needed. */
  editDocument: (
    id: string,
    run: (file: CollaborativeFile) => void,
  ) => Promise<void>;
  reveal: (
    path: string,
    line?: number,
    column?: number,
    length?: number,
  ) => void;
  // Opens a text file and scrolls to a range without moving its selection.
  revealRange: (nodeId: string, range: { from: number; to: number }) => void;
  revealPdf: (path: string, line: number) => void;
  closeTabs: (id: string, mode: "one" | "others" | "all" | "right") => void;
  keepOpen: (id: string) => void;
  openMarkdownPreview: (id: string) => void;
  addSymbolPackage: (packageName: string) => void;
  /** Opens Add reference; `key` names an undefined citation to define. */
  addReference: (key?: string) => void;
  registerEditor: (id: string, view: EditorView | null) => void;
  registerCommands: (
    id: string,
    run: ((command: EditorCommand) => void) | null,
  ) => void;
  reportCursor: (
    id: string,
    position: { line: number; column: number },
  ) => void;
  reportSyntax: (path: string, problems: LatexProblem[]) => void;
  reportGitBranch: (branch: string | null) => void;
  /** Logs the failure and shows "Git unavailable" in the status bar. */
  reportGitFailure: (error: unknown) => void;
};

/** The project's files and the editors' state. */
export type Workspace = {
  /** Live documents: files that are open, or whose edits are unsaved. */
  collaboration: ReadonlyMap<string, CollaborativeFile>;
  /** The scratchpad's live document, while its tab or preview is open. */
  scratchpad: CollaborativeFile | undefined;
  canWrite: boolean;
  paths: ReadonlyMap<string, string>;
  /** The main LaTeX file, if there is one. */
  main: { id: string; path: string } | undefined;
  completion: ReturnType<typeof latexCompletion>;
  jump:
    | {
        id: string;
        line: number;
        column?: number;
        length?: number;
        range?: { from: number; to: number };
      }
    | undefined;
  comments: Comments;
  formatSettings: FormatSettings;
};

/** The latest build and the PDF on screen. */
export type WorkspaceBuild = {
  build: BuildSnapshot | null;
  stale: boolean;
  pdf: File | null;
  pdfSaveState: "saved" | "saving" | "not-saved";
  synctex: SyncTexIndex | null;
  pdfJump: { index: SyncTexIndex; location: SyncTexLocation } | null;
};

/** Problems, which change as the analysis follows edits. */
export type WorkspaceDiagnostics = {
  problems: ReadonlyMap<string, LatexProblem[]>;
  allProblems: LatexProblem[];
};

const ActionsContext = createContext<WorkspaceActions | null>(null);
const WorkspaceContext = createContext<Workspace | null>(null);
const BuildContext = createContext<WorkspaceBuild | null>(null);
const DiagnosticsContext = createContext<WorkspaceDiagnostics | null>(null);

/** Memoize each value: consumers of one are not rendered for the others. */
export function WorkspaceProvider({
  actions,
  workspace,
  build,
  diagnostics,
  children,
}: {
  actions: WorkspaceActions;
  workspace: Workspace;
  build: WorkspaceBuild;
  diagnostics: WorkspaceDiagnostics;
  children: ReactNode;
}) {
  return (
    <ActionsContext value={actions}>
      <WorkspaceContext value={workspace}>
        <BuildContext value={build}>
          <DiagnosticsContext value={diagnostics}>
            {children}
          </DiagnosticsContext>
        </BuildContext>
      </WorkspaceContext>
    </ActionsContext>
  );
}

function required<T>(value: T | null) {
  if (!value) throw new Error("Missing project workspace");
  return value;
}

export function useWorkspaceActions() {
  return required(useContext(ActionsContext));
}
export function useWorkspace() {
  return required(useContext(WorkspaceContext));
}
export function useWorkspaceBuild() {
  return required(useContext(BuildContext));
}
export function useWorkspaceDiagnostics() {
  return required(useContext(DiagnosticsContext));
}
