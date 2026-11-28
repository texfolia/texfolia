import { expect, spyOn, test } from "bun:test";

import { checkHealth } from "./health";

test("reports a database that answers", async () => {
  const response = await checkHealth(async () => {});
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toEqual({ status: "ok" });
});

test("reports a failing or silent database without saying why", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    for (const query of [
      () => Promise.reject(new Error("connect 10.0.0.1 refused")),
      () => new Promise(() => {}),
    ]) {
      const response = await checkHealth(query, 5);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ status: "unavailable" });
    }
    expect(log).toHaveBeenCalledTimes(2);
  } finally {
    log.mockRestore();
  }
});
