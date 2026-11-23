import { expect, test } from "bun:test";

import { createDb } from "@texfolia/db";

import { projectTools } from "../src/tools.server";
import type { AssistantContext, AssistantWorkspace } from "../src/workspace";

const unused = () => {
  throw new Error("Listing tools must not touch the project");
};
const workspace: AssistantWorkspace = {
  lock: unused,
  bucket: { get: unused },
  createNode: unused,
  renameNode: unused,
  deleteNode: unused,
  saveSource: unused,
  gitAction: unused,
  compile: { POST: unused, GET: unused },
};

function toolNames(canWrite: boolean) {
  return projectTools({
    db: createDb("postgres://localhost/unused"),
    // Only the compile tools pass the session through.
    auth: {} as AssistantContext["auth"],
    workspace,
    projectId: crypto.randomUUID(),
    userId: "user",
    canWrite,
    headers: new Headers(),
    signal: new AbortController().signal,
  }).map((tool): string => tool.name);
}

const readOnly = [
  "git_diff",
  "git_status",
  "list_files",
  "list_skills",
  "read_compile_logs",
  "read_file",
  "search_project",
];

test("viewers get only read tools", () => {
  expect(toolNames(false).sort()).toEqual(readOnly);
});

test("editors also get tools that change the project", () => {
  expect(toolNames(true).sort()).toEqual(
    [
      ...readOnly,
      "compile",
      "create_file",
      "delete_file",
      "edit_file",
      "git_checkout",
      "git_commit",
      "git_create_branch",
      "git_pull",
      "git_push",
      "rename_file",
    ].sort(),
  );
});
