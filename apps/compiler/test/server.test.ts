import { expect, test } from "bun:test";
import { HttpError, parseProject } from "../src/compile";
import { createHandler } from "../src/server";

const project = { mainFile: "main.tex", files: { "main.tex": "hello" } };
const request = (body: unknown = project) => new Request("http://localhost/compile", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

test("accepts nested projects and binary assets", () => {
  expect(parseProject({ mainFile: "src/main.tex", files: { "src/main.tex": "hello", "image.png": { base64: "aGk=" } } }).mainFile).toBe("src/main.tex");
});
test("rejects traversal, absolute paths, missing inputs and file collisions", () => {
  for (const path of ["../escape", "/etc/passwd", "C:/secret", "a\\b", "./main.tex"]) {
    expect(() => parseProject({ ...project, files: { ...project.files, [path]: "bad" } })).toThrow(HttpError);
  }
  expect(() => parseProject({ files: {} })).toThrow(HttpError);
  expect(() => parseProject({ ...project, files: { ...project.files, a: "", "a/b": "" } })).toThrow(HttpError);
});
test("requires auth and returns PDF bytes", async () => {
  const handler = createHandler({ token: "secret", compile: async () => ({ pdf: Buffer.from("%PDF-1.5"), log: "" }) });
  expect((await handler(request())).status).toBe(401);
  const authorized = request();
  authorized.headers.set("authorization", "Bearer secret");
  const response = await handler(authorized);
  expect(response.headers.get("content-type")).toBe("application/pdf");
  expect(await response.text()).toBe("%PDF-1.5");
});
test("rejects malformed and oversized projects", async () => {
  const handler = createHandler();
  expect((await handler(request({ files: {} }))).status).toBe(400);
  expect((await handler(request({ files: { "main.tex": "x".repeat(10 * 1024 * 1024) } }))).status).toBe(413);
});
test("reports errors, rejects overlapping jobs and accepts work after failure", async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const handler = createHandler({ compile: async () => {
    await pending;
    throw new HttpError(422, "LaTeX compilation failed", "undefined control sequence");
  } });
  const first = handler(request());
  expect((await handler(request())).status).toBe(503);
  release();
  expect((await first).status).toBe(422);
  const next = await handler(request());
  expect(next.status).toBe(422);
  expect(await next.json()).toMatchObject({ log: "undefined control sequence" });
});
