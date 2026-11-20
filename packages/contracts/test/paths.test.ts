import { expect, test } from "bun:test";

import fixtures from "../fixtures/path-policy.json";
import {
  artifactPathSchema,
  maxSourcePathBytes,
  nodeNameSchema,
  pathBytes,
  sourcePathSchema,
} from "../src";

// The Go engine reads the same fixtures in engine/path_policy_test.go.
for (const fixture of fixtures)
  test(`path policy: ${JSON.stringify(fixture.path)}`, () => {
    expect(artifactPathSchema.safeParse(fixture.path).success).toBe(
      fixture.artifact,
    );
    expect(sourcePathSchema.safeParse(fixture.path).success).toBe(
      fixture.source,
    );
    expect(nodeNameSchema.safeParse(fixture.path).success).toBe(
      fixture.artifact &&
        pathBytes(fixture.path) <= maxSourcePathBytes &&
        !fixture.path.includes("/"),
    );
    if (fixture.source)
      expect(sourcePathSchema.parse(fixture.path)).toBe(fixture.path);
  });

test("reports the source length limit before other issues", () => {
  const issues = sourcePathSchema.safeParse("a".repeat(300)).error?.issues;
  expect(issues?.[0]?.message).toContain("240 UTF-8 bytes");
});
