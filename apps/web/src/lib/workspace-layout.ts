import type { DockviewApi, SerializedDockview } from "dockview-react";
import { z } from "zod";

export const sidebarViewSchema = z.enum([
  "files",
  "outline",
  "git",
  "collaboration",
]);
export type SidebarView = z.infer<typeof sidebarViewSchema>;
const chromeSchema = z.object({
  historyOpen: z.boolean().default(false),
  historyWidth: z.number().min(240).max(600).default(240),
  agentsOpen: z.boolean(),
  agentsWidth: z.number().min(240).max(600),
  rightOpen: z.boolean(),
  rightWidth: z.number().min(240).max(600),
  rightView: sidebarViewSchema,
});
export type WorkspaceChrome = z.infer<typeof chromeSchema>;
export const defaultWorkspaceChrome: WorkspaceChrome = {
  historyOpen: false,
  historyWidth: 240,
  agentsOpen: true,
  agentsWidth: 320,
  rightOpen: true,
  rightWidth: 288,
  rightView: "files",
};
export const workspaceLayoutKey = (userId: string, projectId: string) =>
  `texfolia.workspace.layout.v1:${userId}:${projectId}`;

export function readWorkspaceLayout(raw: string | null): {
  chrome: WorkspaceChrome;
  dock: unknown;
} {
  try {
    const value = z
      .object({ chrome: chromeSchema, dock: z.unknown().optional() })
      .parse(JSON.parse(raw ?? "null"));
    return { chrome: value.chrome, dock: value.dock };
  } catch {
    return { chrome: defaultWorkspaceChrome, dock: undefined };
  }
}

export function writeWorkspaceLayout(
  key: string,
  chrome: WorkspaceChrome,
  dock: SerializedDockview | undefined,
) {
  try {
    localStorage.setItem(key, JSON.stringify({ chrome, dock }));
  } catch {
    /* The workspace remains usable when browser storage is full or disabled. */
  }
}

export function restoreWorkspaceDock(
  dock: DockviewApi,
  raw: unknown,
  nodes: { id: string; kind: string; name: string }[],
) {
  const parsed = z
    .object({
      grid: z.object({
        root: z.unknown(),
        height: z.number(),
        width: z.number(),
        orientation: z.string(),
      }),
      panels: z.record(
        z.string(),
        z.looseObject({
          id: z.string(),
          contentComponent: z.enum([
            "editor",
            "generated",
            "markdown",
            "problems",
            "settings",
          ]),
          params: z.record(z.string(), z.unknown()).optional(),
        }),
      ),
    })
    .passthrough()
    .safeParse(raw);
  if (!parsed.success) return false;
  const value = parsed.data;
  for (const panel of Object.values(value.panels)) {
    if (panel.contentComponent === "editor") {
      const node = nodes.find(
        (node) => node.id === panel.id && node.kind !== "folder",
      );
      if (!node) return false;
      panel.params = { node, preview: panel.params?.preview === true };
    }
    if (panel.contentComponent === "generated") {
      if (
        typeof panel.params?.path !== "string" ||
        panel.id !== `out:${panel.params.path}`
      )
        return false;
      panel.params = {
        path: panel.params.path,
        preview: panel.params.preview === true,
      };
    }
    if (panel.contentComponent === "markdown") {
      if (
        !panel.id.startsWith("markdown:") ||
        !nodes.some(
          (node) =>
            node.id === panel.id.slice(9) &&
            node.kind === "text" &&
            /\.(md|markdown)$/i.test(node.name),
        )
      )
        return false;
      panel.params = { source: "" };
    }
    if (
      (panel.contentComponent === "problems" ||
        panel.contentComponent === "settings") &&
      panel.id !== panel.contentComponent
    )
      return false;
  }
  try {
    // Dockview owns and validates the opaque grid format; panel inputs above belong to us.
    dock.fromJSON(value as SerializedDockview);
    return true;
  } catch {
    dock.clear();
    return false;
  }
}
