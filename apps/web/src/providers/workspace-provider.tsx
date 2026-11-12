import type { EditorView } from "@uiw/react-codemirror";
import { createContext, type ReactNode, useContext } from "react";

import type { BuildSnapshot } from "#/lib/build";
import type { LatexProblem } from "#/lib/latex/analysis";
import type { latexCompletion } from "#/lib/latex/completion";
import type { FormatSettings } from "#/lib/latex/format";

export type FileState = { value: string; savedValue: string };
export type Workspace = {
  projectId: string;
  canWrite: boolean;
  build: BuildSnapshot | null;
  stale: boolean;
  drafts: Map<string, FileState>;
  paths: ReadonlyMap<string, string>;
  completion: ReturnType<typeof latexCompletion>;
  problems: ReadonlyMap<string, LatexProblem[]>;
  reportSyntax: (path: string, problems: LatexProblem[]) => void;
  jump: { id: string; line: number } | undefined;
  pdf: File | null;
  pdfSaveState: "saved" | "saving" | "not-saved";
  formatSettings: FormatSettings;
  keepOpen: (id: string) => void;
  openMarkdownPreview: (id: string) => void;
  change: (id: string, value: string) => void;
  symbolPreamble: { source: string; filename: string } | undefined;
  addSymbolPackage: (packageName: string) => void;
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
