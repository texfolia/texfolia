import { expect, test } from "bun:test";

import type { DockviewApi } from "dockview-react";

import {
  defaultWorkspaceChrome,
  readWorkspaceLayout,
  restoreWorkspaceDock,
  workspaceLayoutKey,
  type WorkspaceChrome,
} from "./workspace-layout";

test("workspace memory is isolated by user and project", () => {
  expect(workspaceLayoutKey("u1", "p1")).toBe(
    "texfolia.workspace.layout.v1:u1:p1",
  );
  expect(workspaceLayoutKey("u1", "p1")).not.toBe(
    workspaceLayoutKey("u2", "p1"),
  );
  expect(workspaceLayoutKey("u1", "p1")).not.toBe(
    workspaceLayoutKey("u1", "p2"),
  );
});

test("layout memory restores chrome and the opaque dock; corrupt or invalid chrome recovers safely", () => {
  const chrome = {
    ...defaultWorkspaceChrome,
    agentsOpen: false,
    rightWidth: 400,
    rightView: "outline",
  } satisfies WorkspaceChrome;
  expect(
    readWorkspaceLayout(JSON.stringify({ chrome, dock: { panels: {} } })),
  ).toEqual({ chrome, dock: { panels: {} } });
  for (const raw of [
    null,
    "{",
    JSON.stringify({ chrome: { ...chrome, rightWidth: -1 } }),
    JSON.stringify({ chrome: { ...chrome, rightView: "unknown" } }),
  ])
    expect(readWorkspaceLayout(raw).chrome).toEqual(defaultWorkspaceChrome);
});

test("the bottom panel is closed by default, including for layouts saved before it existed", () => {
  expect(defaultWorkspaceChrome.panelOpen).toBe(false);
  const {
    panelOpen: _open,
    panelHeight: _height,
    panelView: _view,
    ...legacy
  } = defaultWorkspaceChrome;
  expect(
    readWorkspaceLayout(JSON.stringify({ chrome: legacy })).chrome,
  ).toEqual(defaultWorkspaceChrome);
  const open = {
    ...defaultWorkspaceChrome,
    panelOpen: true,
    panelView: "logs",
  } satisfies WorkspaceChrome;
  expect(readWorkspaceLayout(JSON.stringify({ chrome: open })).chrome).toEqual(
    open,
  );
});

test("restored editor tabs use the default renderer, even if saved with another", () => {
  let restored: { panels: Record<string, { renderer?: unknown }> } | undefined;
  const dock = {
    fromJSON: (value: typeof restored) => {
      restored = value;
    },
    getPanel: () => undefined,
    clear: () => {},
  } as unknown as DockviewApi;
  const node = { id: "n1", kind: "text", name: "main.tex" };
  const ok = restoreWorkspaceDock(
    dock,
    {
      grid: { root: {}, height: 1, width: 1, orientation: "HORIZONTAL" },
      panels: {
        n1: {
          id: "n1",
          contentComponent: "editor",
          renderer: "always",
          params: { node },
        },
      },
    },
    [node],
  );
  expect(ok).toBe(true);
  expect(restored?.panels.n1).not.toHaveProperty("renderer");
});
