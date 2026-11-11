import { expect, test } from "bun:test";

import { createEngineClient } from "../src/engine";
import { HttpError } from "../src/project";
import { unknownEngineTiming } from "../src/telemetry";

const context = {
  jobId: crypto.randomUUID(),
  attempt: 1,
  plan: "free" as const,
};
const project = { mainFile: "main.tex", files: { "main.tex": "hello" } };

test("engine client sends sources and reads multipart PDF and diagnostics", async () => {
  const engine = createEngineClient(async (request) => {
    expect(request.url).toBe("http://engine:8080/compile");
    expect(request.method).toBe("POST");
    expect(request.headers.get("X-Compilation-Id")).toBe(context.jobId);
    expect(request.headers.get("X-Compile-Attempt")).toBe("1");
    expect(request.headers.get("X-Compile-Plan")).toBe("free");
    expect(request.headers.get("Content-Type")).toBe("application/json");
    expect(await request.json()).toEqual(project);
    const form = new FormData();
    form.set(
      "pdf",
      new Blob(["%PDF-1.5"], { type: "application/pdf" }),
      "output.pdf",
    );
    form.set("log", "TeX transcript");
    form.set("artifact:main.aux", new Blob(["aux cache"]), "main.aux");
    form.set(
      "artifact:nested/custom.data",
      new Blob([new Uint8Array([0, 1, 2, 255])]),
      "custom.data",
    );
    return new Response(form, {
      headers: {
        "X-Compile-Timing": JSON.stringify({
          engine: "tectonic",
          temperature: "cold",
          inputPrepMs: 2,
          compileMs: 10,
          outputMs: 3,
        }),
      },
    });
  }, "http://engine:8080");
  const result = await engine(project, context);
  expect(new TextDecoder().decode(result.pdf)).toBe("%PDF-1.5");
  expect(result.log).toBe("TeX transcript");
  expect(await result.files?.["main.aux"]?.text()).toBe("aux cache");
  expect(
    new Uint8Array(await result.files!["nested/custom.data"]!.arrayBuffer()),
  ).toEqual(new Uint8Array([0, 1, 2, 255]));
  expect(result.timing).toEqual({
    engine: "tectonic",
    temperature: "cold",
    inputPrepMs: 2,
    compileMs: 10,
    outputMs: 3,
  });
});

test("engine client distinguishes terminal failures from infrastructure errors", async () => {
  for (const status of [400, 408, 413, 422]) {
    const engine = createEngineClient(async () =>
      Response.json({ error: "Failed", log: "diagnostic" }, { status }),
    );
    try {
      await engine(project, context);
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
  await expect(busy(project, context)).rejects.toThrow("TeX host returned 503");
  const invalid = createEngineClient(async () => new Response(new FormData()));
  await expect(invalid(project, context)).rejects.toThrow(
    "TeX host returned an invalid result",
  );
});

test("absent or malformed timing from older engines does not reject valid output", async () => {
  for (const header of ["{", JSON.stringify({ compileMs: -1 }), "null"]) {
    const engine = createEngineClient(async () => {
      const form = new FormData();
      form.set("pdf", new Blob(["%PDF-1.5"]));
      form.set("log", "ok");
      return new Response(form, { headers: { "X-Compile-Timing": header } });
    });
    expect((await engine(project, context)).timing).toEqual(
      unknownEngineTiming,
    );
  }
});
