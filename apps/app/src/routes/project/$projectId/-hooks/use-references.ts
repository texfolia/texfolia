import { entryAppendix, newBibFile } from "@texfolia/editor";
import { useMemo, useState } from "react";

import type { ProjectNode } from "#/lib/projects";
import { encodeSource } from "#/lib/storage";
import type { FileDrafts } from "#/lib/workspace/file-drafts";
import type { useProjectFiles } from "#/providers/project-files-provider";

import type { AddReferenceRequest } from "../-components/add-reference-dialog";
import type { useCollaborationFiles } from "./use-collaboration-files";
import type { useDockPanels } from "./use-dock-panels";

/** Adds entries to the project's bibliographies, and cites them. */
export function useReferences({
  writable,
  files,
  nodes,
  paths,
  drafts,
  panels,
  collaboration,
}: {
  writable: boolean;
  files: ReturnType<typeof useProjectFiles>;
  nodes: readonly ProjectNode[];
  paths: ReadonlyMap<string, string>;
  drafts: FileDrafts;
  panels: Pick<ReturnType<typeof useDockPanels>, "activeEditor" | "activeId">;
  collaboration: Pick<ReturnType<typeof useCollaborationFiles>, "get" | "edit">;
}) {
  const [request, setRequest] = useState<AddReferenceRequest | null>(null);
  const bibFiles = useMemo(
    () =>
      [...paths]
        .filter(([, path]) => /\.bib$/i.test(path))
        .map(([id, path]) => ({ id, path }))
        .sort((a, b) => a.path.localeCompare(b.path)),
    [paths],
  );

  /** Opens Add reference, offering to cite at the cursor of a LaTeX tab. */
  function addReference(key?: string) {
    if (!writable) return;
    const view = panels.activeEditor();
    const path = panels.activeId ? paths.get(panels.activeId) : undefined;
    setRequest({
      key,
      cite:
        view && path && /\.(?:tex|ltx)$/i.test(path)
          ? {
              path,
              insert: (citation) => {
                if (!view.dom.isConnected) return;
                view.dispatch(
                  view.state.replaceSelection(`\\cite{${citation}}`),
                );
                view.focus();
              },
            }
          : undefined,
    });
  }

  function readBib(id: string) {
    return (
      collaboration.get(id)?.text.toString() ?? drafts.get(id)?.value ?? ""
    );
  }

  function appendBib(id: string, entry: string) {
    return collaboration.edit(id, (file) => {
      const value = file.text.toString();
      file.replace(value + entryAppendix(value, entry));
    });
  }

  async function createBib(content: string) {
    const root = nodes.find(
      (node) => node.kind === "folder" && node.parentId === null,
    );
    if (!root) throw new Error("This project has no root folder.");
    await files.create({
      kind: "text",
      parentId: root.id,
      name: newBibFile,
      content: encodeSource(new TextEncoder().encode(content)),
    });
  }

  return {
    addReference,
    request,
    close: () => setRequest(null),
    bibFiles,
    readBib,
    appendBib,
    createBib,
  };
}
