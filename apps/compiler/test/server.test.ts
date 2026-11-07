import { expect, test } from "bun:test";

import { HttpError, parseProject } from "../src/project";
import { createEngineHandler } from "../src/server";

const project = { mainFile: "main.tex", files: { "main.tex": "hello" } };
const request = (body: unknown = project) =>
  new Request("http://localhost/compile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

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
test("accepts work over the private container connection without a token", async () => {
  const handler = createEngineHandler({
    compile: async () => ({ pdf: Buffer.from("%PDF-1.5"), log: "" }),
  });
  const response = await handler(request());
  expect(response.status).toBe(200);
});
test("rejects malformed and oversized projects", async () => {
  const handler = createEngineHandler();
  expect((await handler(request({ files: {} }))).status).toBe(400);
  expect(
    (
      await handler(
        request({ files: { "main.tex": "x".repeat(10 * 1024 * 1024) } }),
      )
    ).status,
  ).toBe(413);
});
test("reports errors, rejects overlapping jobs and accepts work after failure", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handler = createEngineHandler({
    compile: async () => {
      await pending;
      throw new HttpError(
        422,
        "LaTeX compilation failed",
        "undefined control sequence",
      );
    },
  });
  const first = handler(request());
  expect((await handler(request())).status).toBe(503);
  release();
  expect((await first).status).toBe(422);
  const next = await handler(request());
  expect(next.status).toBe(422);
  expect(await next.json()).toMatchObject({
    log: "undefined control sequence",
  });
});

test("returns the PDF and log when multipart is requested", async () => {
  const handler = createEngineHandler({
    compile: async () => ({
      pdf: Buffer.from("%PDF-1.5"),
      log: "warning: main.tex:3: Reference undefined",
    }),
  });
  const input = request();
  input.headers.set("Accept", "multipart/form-data");
  const response = await handler(input);
  expect(response.status).toBe(200);
  const form = await response.formData();
  const pdf = form.get("pdf");
  expect(pdf).toBeInstanceOf(Blob);
  if (pdf instanceof Blob) expect(await pdf.text()).toBe("%PDF-1.5");
  expect(form.get("log")).toBe("warning: main.tex:3: Reference undefined");
});
