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

export type FileState = { value: string; savedValue: string };
export type Workspace = {
  /** Live documents: files that are open, or whose edits are unsaved. */
  collaboration: ReadonlyMap<string, CollaborativeFile>;
  /** Connects a text file's document until the returned function is called. */
  holdDocument: (id: string) => () => void;
  /** Edits a text file's collaborative document, connecting it if needed. */
  editDocument: (
    id: string,
    run: (file: CollaborativeFile) => void,
  ) => Promise<void>;
  projectId: string;
  canWrite: boolean;
  build: BuildSnapshot | null;
  stale: boolean;
  drafts: Map<string, FileState>;
  paths: ReadonlyMap<string, string>;
  completion: ReturnType<typeof latexCompletion>;
  problems: ReadonlyMap<string, LatexProblem[]>;
  allProblems: LatexProblem[];
  reveal: (
    path: string,
    line?: number,
    column?: number,
    length?: number,
  ) => void;
  closeTabs: (id: string, mode: "one" | "others" | "all" | "right") => void;
  reportGitBranch: (branch: string | null) => void;
  /** Logs the failure and shows "Git unavailable" in the status bar. */
  reportGitFailure: (error: unknown) => void;
  registerCommands: (
    id: string,
    run: ((command: EditorCommand) => void) | null,
  ) => void;
  reportCursor: (
    id: string,
    position: { line: number; column: number },
  ) => void;
  reportSyntax: (path: string, problems: LatexProblem[]) => void;
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
  // Opens a text file and scrolls to a range without moving its selection.
  revealRange: (nodeId: string, range: { from: number; to: number }) => void;
  pdf: File | null;
  synctex: SyncTexIndex | null;
  pdfJump: { index: SyncTexIndex; location: SyncTexLocation } | null;
  revealPdf: (path: string, line: number) => void;
  pdfSaveState: "saved" | "saving" | "not-saved";
  formatSettings: FormatSettings;
  keepOpen: (id: string) => void;
  openMarkdownPreview: (id: string) => void;
  symbolPreamble: { source: string; filename: string } | undefined;
  addSymbolPackage: (packageName: string) => void;
  /** Opens Add reference; `key` names an undefined citation to define. */
  addReference: (key?: string) => void;
  registerEditor: (id: string, view: EditorView | null) => void;
};

const WorkspaceContext = createContext<Workspace | null>(null);

export function WorkspaceProvider({
  value,
  children,
}: {
  value: Workspace;
  children: ReactNode;
}) {
  return <WorkspaceContext value={value}>{children}</WorkspaceContext>;
}

export function useWorkspace() {
  const workspace = useContext(WorkspaceContext);
  if (!workspace) throw new Error("Missing project workspace");
  return workspace;
}
