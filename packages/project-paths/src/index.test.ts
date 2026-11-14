import { expect, test } from "bun:test";

import fixtures from "../fixtures.json";
import {
  artifactPathSchema,
  nodeNameSchema,
  pathBytes,
  sourcePathSchema,
} from "./index";

for (const fixture of fixtures)
  test(`path policy: ${JSON.stringify(fixture.path)}`, () => {
    expect(sourcePathSchema.safeParse(fixture.path).success).toBe(
      fixture.source,
    );
    expect(artifactPathSchema.safeParse(fixture.path).success).toBe(
      fixture.artifact,
    );
    expect(nodeNameSchema.safeParse(fixture.path).success).toBe(
      fixture.artifact &&
        pathBytes(fixture.path) <= 240 &&
        !fixture.path.includes("/"),
    );
    if (fixture.source)
      expect(sourcePathSchema.parse(fixture.path)).toBe(fixture.path);
  });
