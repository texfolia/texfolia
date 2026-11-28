import { expect, test } from "bun:test";

import {
  projectMetadataSchema,
  projectMetadataVersion,
  projectSourcesFingerprint,
  type ProjectMetadata,
} from "./metadata";

const main = {
  id: "main",
  projectId: "project",
  parentId: "root",
  name: "main.tex",
  kind: "text",
} satisfies ProjectMetadata["nodes"][number];

const metadata = {
  nodes: [
    {
      id: "root",
      projectId: "project",
      parentId: null,
      name: "Project",
      kind: "folder",
    },
    main,
    {
      id: "folder",
      projectId: "project",
      parentId: "root",
      name: "chapters",
      kind: "folder",
    },
    {
      id: "image",
      projectId: "project",
      parentId: "root",
      name: "figure.png",
      kind: "binary",
    },
  ],
  sourceVersions: {
    main: { objectKey: "sources/before.tex", updatedAt: 1 },
    image: { objectKey: "sources/figure.png", updatedAt: 1 },
  },
  canWrite: true,
  mainFile: null,
} satisfies ProjectMetadata;

test("live text exports tolerate autosaves while compilation detects saved text changes", async () => {
  const saved = {
    ...metadata,
    sourceVersions: {
      ...metadata.sourceVersions,
      main: { objectKey: "sources/after.tex", updatedAt: 2 },
    },
  };
  expect(await projectMetadataVersion({ ...saved, textSource: "live" })).toBe(
    await projectMetadataVersion({ ...metadata, textSource: "live" }),
  );
  expect(await projectMetadataVersion(saved)).not.toBe(
    await projectMetadataVersion(metadata),
  );
});

test("live text exports still detect binary source changes", async () => {
  const changed = {
    ...metadata,
    sourceVersions: {
      ...metadata.sourceVersions,
      image: { objectKey: "sources/replacement.png", updatedAt: 2 },
    },
  };
  expect(
    await projectMetadataVersion({ ...changed, textSource: "live" }),
  ).not.toBe(await projectMetadataVersion({ ...metadata, textSource: "live" }));
});

test("live text exports detect created, deleted, renamed, and moved files", async () => {
  const before = await projectMetadataVersion({
    ...metadata,
    textSource: "live",
  });
  for (const nodes of [
    [...metadata.nodes, { ...main, id: "new", name: "new.tex" }],
    metadata.nodes.filter((node) => node.id !== "main"),
    metadata.nodes.map((node) =>
      node.id === "main" ? { ...node, name: "renamed.tex" } : node,
    ),
    metadata.nodes.map((node) =>
      node.id === "main" ? { ...node, parentId: "folder" } : node,
    ),
  ]) {
    expect(
      await projectMetadataVersion({ ...metadata, nodes, textSource: "live" }),
    ).not.toBe(before);
  }
});

test("projectSourcesFingerprint is deterministic across node order and reflects saved object changes", () => {
  const reversed = { ...metadata, nodes: [...metadata.nodes].reverse() };
  expect(projectSourcesFingerprint(reversed)).toBe(
    projectSourcesFingerprint(metadata),
  );
  expect(
    projectSourcesFingerprint({
      ...metadata,
      sourceVersions: {
        ...metadata.sourceVersions,
        main: { objectKey: "sources/after.tex" },
      },
    }),
  ).not.toBe(projectSourcesFingerprint(metadata));
  expect(
    projectMetadataSchema.parse({
      nodes: [],
      sourceVersions: {},
      canWrite: true,
      gitVersion: "git/p/1.json",
    }).gitVersion,
  ).toBe("git/p/1.json");
});
