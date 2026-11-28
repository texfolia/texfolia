import { expect, test } from "bun:test";

import { lazy } from "./lazy";

class Service {
  api = { name: "api" };
  count = 2;
  handler() {
    return this.count;
  }
}

test("lazy builds the object once, on first use", () => {
  let builds = 0;
  const service = lazy(() => {
    builds++;
    return new Service();
  });

  // Request context is copied key by key, which must not build the object.
  const context = Object.assign({}, { service });
  expect(builds).toBe(0);

  expect(context.service.api.name).toBe("api");
  const handler = context.service.handler as () => number;
  expect(handler()).toBe(2);
  expect("count" in context.service).toBe(true);
  expect(builds).toBe(1);
});
