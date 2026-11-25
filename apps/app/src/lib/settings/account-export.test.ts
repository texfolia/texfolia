import { expect, test } from "bun:test";

import { folderNames } from "./account-export.server";

test("project folders are safe to extract and never merge", () => {
  const folder = folderNames();
  expect(
    ["Thesis", "thesis", "Thesis", "a/b", "a\\b", "..", "", "End. "].map(
      folder,
    ),
  ).toEqual([
    "Thesis",
    "thesis (2)",
    "Thesis (3)",
    "a_b",
    "a_b (2)",
    "project",
    "project (2)",
    "End",
  ]);
});
