import { expect, test } from "bun:test";

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
