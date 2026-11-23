import { expect, test } from "bun:test";

import { isTemplateReviewer } from "../src/server";

test("reviewers are an exact comma-separated list", () => {
  expect(isTemplateReviewer("b", " a, b ,")).toBe(true);
  expect(isTemplateReviewer("ab", "a,b")).toBe(false);
  expect(isTemplateReviewer("", "a,,b")).toBe(false);
  expect(isTemplateReviewer("a", "")).toBe(false);
});
