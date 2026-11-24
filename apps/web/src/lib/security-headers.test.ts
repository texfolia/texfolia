import { expect, test } from "bun:test";

import { securityHeaders, withSecurityHeaders } from "./security-headers";

test("Worker responses keep their status, headers, and body", async () => {
  const response = withSecurityHeaders(
    new Response("missing", {
      status: 404,
      headers: { "Content-Type": "text/html" },
    }),
  );
  expect(response.status).toBe(404);
  expect(response.headers.get("Content-Type")).toBe("text/html");
  for (const [name, value] of Object.entries(securityHeaders))
    expect(response.headers.get(name)).toBe(value);
  expect(await response.text()).toBe("missing");
});

test("development omits CSP and HSTS", () => {
  const { headers } = withSecurityHeaders(new Response("dev"), true);
  expect(headers.has("Content-Security-Policy")).toBe(false);
  expect(headers.has("Strict-Transport-Security")).toBe(false);
  expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
});

test("static assets get the same headers as Worker responses", async () => {
  const file = await Bun.file(
    new URL("../../public/_headers", import.meta.url),
  ).text();
  const [path, ...lines] = file.trim().split("\n");
  expect(path).toBe("/*");
  const headers = Object.fromEntries(
    lines.map((line) => {
      const [name = "", ...value] = line.trim().split(": ");
      return [name, value.join(": ")];
    }),
  );
  expect(headers).toEqual(securityHeaders);
});
