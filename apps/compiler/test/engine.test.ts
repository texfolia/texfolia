import { expect, test } from "bun:test";

import { createEngineClient } from "../src/engine";
import { HttpError } from "../src/project";

const project = { mainFile: "main.tex", files: { "main.tex": "hello" } };

test("engine client sends sources and reads multipart PDF and diagnostics", async () => {
  const engine = createEngineClient(async (request) => {
    expect(request.url).toBe("http://engine:8080/compile");
    expect(request.method).toBe("POST");
    expect(request.headers.get("Content-Type")).toBe("application/json");
    expect(await request.json()).toEqual(project);
    const form = new FormData();
    form.set(
      "pdf",
      new Blob(["%PDF-1.5"], { type: "application/pdf" }),
      "output.pdf",
    );
    form.set("log", "TeX transcript");
    return new Response(form);
  }, "http://engine:8080");
  const result = await engine(project);
  expect(new TextDecoder().decode(result.pdf)).toBe("%PDF-1.5");
  expect(result.log).toBe("TeX transcript");
});

test("engine client distinguishes terminal failures from infrastructure errors", async () => {
  for (const status of [400, 408, 413, 422]) {
    const engine = createEngineClient(async () =>
      Response.json({ error: "Failed", log: "diagnostic" }, { status }),
    );
    try {
      await engine(project);
      throw new Error("Expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      if (error instanceof HttpError) {
        expect(error.status).toBe(status);
        expect(error.log).toBe("diagnostic");
      }
    }
  }
  const busy = createEngineClient(async () =>
    Response.json({ error: "Busy" }, { status: 503 }),
  );
  await expect(busy(project)).rejects.toThrow("TeX host returned 503");
  const invalid = createEngineClient(async () => new Response(new FormData()));
  await expect(invalid(project)).rejects.toThrow(
    "TeX host returned an invalid result",
  );
});
