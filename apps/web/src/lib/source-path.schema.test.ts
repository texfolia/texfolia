import { expect, test } from "bun:test";

import fixtures from "../../../compiler/test/fixtures/path-policy.json";
import {
  nodeNameSchema,
  pathBytes,
  sourcePathSchema,
} from "./source-path.schema";

for (const fixture of fixtures)
  test(`path policy: ${JSON.stringify(fixture.path)}`, () => {
    expect(sourcePathSchema.safeParse(fixture.path).success).toBe(
      fixture.source,
    );
    expect(nodeNameSchema.safeParse(fixture.path).success).toBe(
      fixture.artifact &&
        pathBytes(fixture.path) <= 240 &&
        !fixture.path.includes("/"),
    );
    if (fixture.source)
      expect(sourcePathSchema.parse(fixture.path)).toBe(fixture.path);
  });
