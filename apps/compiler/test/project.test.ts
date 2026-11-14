import { expect, test } from "bun:test";

import pathFixtures from "../../../packages/project-paths/fixtures.json";
import { HttpError, parseProject } from "../src/project";

const project = { mainFile: "main.tex", files: { "main.tex": "hello" } };
test("accepts nested projects and binary assets", () => {
  expect(
    parseProject({
      mainFile: "src/main.tex",
      files: { "src/main.tex": "hello", "image.png": { base64: "aGk=" } },
    }).mainFile,
  ).toBe("src/main.tex");
});
test("rejects traversal, absolute paths, missing inputs and file collisions", () => {
  for (const path of [
    "../escape",
    "/etc/passwd",
    "C:/secret",
    "a\\b",
    "./main.tex",
  ]) {
    expect(() =>
      parseProject({ ...project, files: { ...project.files, [path]: "bad" } }),
    ).toThrow(HttpError);
  }
  expect(() => parseProject({ files: {} })).toThrow(HttpError);
  expect(() =>
    parseProject({ ...project, files: { ...project.files, a: "", "a/b": "" } }),
  ).toThrow(HttpError);
});

// The Go engine consumes the same fixtures, including the UTF-8 byte boundaries.

for (const fixture of pathFixtures)
  test(`compiler source path: ${JSON.stringify(fixture.path)}`, () => {
    const input = {
      ...project,
      files: { ...project.files, [fixture.path]: "source" },
    };
    if (fixture.source)
      expect(parseProject(input).files[fixture.path]).toBe("source");
    else expect(() => parseProject(input)).toThrow(HttpError);
  });
