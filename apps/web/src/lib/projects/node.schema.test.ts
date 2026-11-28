import { expect, test } from "bun:test";

import { nodeNameSchema } from "./node.schema";

test("source names reject colons and paths beyond the compiler's byte limit", () => {
  for (const name of ["chapter:1.tex", "a".repeat(241), "é".repeat(121)])
    expect(nodeNameSchema.safeParse(name).success).toBe(false);
  for (const name of ["chapter.tex", "a".repeat(240), "é".repeat(120)])
    expect(nodeNameSchema.parse(name)).toBe(name);
});
