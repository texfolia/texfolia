import { expect, test } from "bun:test";

import {
  defaultWorkspaceChrome,
  readWorkspaceLayout,
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
