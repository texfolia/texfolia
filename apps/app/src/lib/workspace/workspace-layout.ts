import type { DockviewApi, SerializedDockview } from "dockview-react";
import { z } from "zod";

import { scratchpadId } from "#/lib/collaboration";
import { hasSourcePreview } from "#/lib/storage/preview";

export const sidebarViewSchema = z.enum([
  "files",
  "outline",
  "search",
  "git",
  "comments",
  "collaboration",
]);
export type SidebarView = z.infer<typeof sidebarViewSchema>;
export const panelViewSchema = z.enum(["problems", "logs", "terminal"]);
export type PanelView = z.infer<typeof panelViewSchema>;
export const panelHeightBounds = { min: 120, max: 640 };
export const sidebarWidthBounds = { min: 240, max: 600 };
const sidebarWidth = z
  .number()
  .min(sidebarWidthBounds.min)
  .max(sidebarWidthBounds.max);
const chromeSchema = z.object({
  historyOpen: z.boolean().default(false),
  historyWidth: sidebarWidth.default(240),
  agentsOpen: z.boolean(),
  agentsWidth: sidebarWidth,
  rightOpen: z.boolean(),
  rightWidth: sidebarWidth,
  rightView: sidebarViewSchema,
  // The bottom panel stays closed until the user opens it.
  panelOpen: z.boolean().default(false),
  panelHeight: z
    .number()
    .min(panelHeightBounds.min)
    .max(panelHeightBounds.max)
    .default(240),
  panelView: panelViewSchema.default("problems"),
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
  panelOpen: false,
  panelHeight: 240,
  panelView: "problems",
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

/** Whether a dock component edits text, rather than previewing something. */
export function isEditorComponent(component: string) {
  return component === "editor" || component === "scratchpad";
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
            "scratchpad",
            "problems",
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
      // Layouts saved before editors used the default renderer kept every
      // editor tab rendered.
      delete panel.renderer;
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
        panel.id !== `markdown:${scratchpadId}` &&
        (!panel.id.startsWith("markdown:") ||
          !nodes.some(
            (node) =>
              node.id === panel.id.slice(9) &&
              node.kind === "text" &&
              hasSourcePreview(node.name),
          ))
      )
        return false;
      panel.params = { source: "" };
    }
    if (panel.contentComponent === "scratchpad") {
      if (panel.id !== scratchpadId) return false;
      panel.params = {};
    }
    if (
      panel.contentComponent === "problems" &&
      panel.id !== panel.contentComponent
    )
      return false;
  }
  try {
    // Dockview owns and validates the opaque grid format; panel inputs above belong to us.
    dock.fromJSON(value as SerializedDockview);
    // Problems moved from a dock tab to the bottom panel.
    const legacy = dock.getPanel("problems");
    if (legacy) dock.removePanel(legacy);
    return true;
  } catch {
    dock.clear();
    return false;
  }
}
