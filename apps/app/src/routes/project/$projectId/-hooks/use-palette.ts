import { useRef, useState } from "react";

import type { ProjectNode } from "#/lib/projects";

import type {
  PaletteFile,
  PaletteMode,
} from "../-components/workspace-palette";
import type { useCompilation } from "./use-compilation";
import type { useDockPanels } from "./use-dock-panels";

/** Go to file, and the list of commands. */
export function usePalette({
  nodes,
  paths,
  panels,
  compilation,
}: {
  nodes: readonly ProjectNode[];
  paths: ReadonlyMap<string, string>;
  panels: Pick<
    ReturnType<typeof useDockPanels>,
    "reveal" | "openFile" | "openGenerated" | "recentIds"
  >;
  compilation: Pick<ReturnType<typeof useCompilation>, "build">;
}) {
  const [request, setRequest] = useState<{
    mode: PaletteMode;
    sequence: number;
  } | null>(null);
  const sequence = useRef(0);
  function open(mode: PaletteMode) {
    setRequest({ mode, sequence: ++sequence.current });
  }

  /** Every file, the last ones used first, except for the one on screen. */
  function files(): PaletteFile[] {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const entries = [...paths].flatMap(([id, path]) => {
      const node = byId.get(id);
      return node ? [{ id, path, node }] : [];
    });
    const listed = [
      ...entries
        .sort((a, b) => a.path.localeCompare(b.path))
        .map(({ id, path, node }) => ({
          id,
          path,
          open(line?: number, column?: number) {
            if (line && node.kind === "text") panels.reveal(path, line, column);
            else panels.openFile(node, true);
          },
        })),
      ...(compilation.build?.artifacts?.files ?? []).map(({ path }) => ({
        id: `out:${path}`,
        path: `out/${path}`,
        open: () => panels.openGenerated(path, true),
      })),
    ];
    const recent = panels.recentIds();
    const order = (id: string) => {
      const index = recent.indexOf(id);
      // The current file is the least likely to be wanted.
      return index < 0 ? recent.length : index || recent.length + 1;
    };
    return listed.sort((a, b) => order(a.id) - order(b.id));
  }

  return { request, open, files, close: () => setRequest(null) };
}
