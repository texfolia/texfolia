import { expect, test } from "bun:test";

import { parseFileQuery } from "./file-query";

test("a file query may end with a line and a column", () => {
  expect(parseFileQuery("intro")).toMatchObject({ text: "intro" });
  expect(parseFileQuery("intro:12")).toMatchObject({ text: "intro", line: 12 });
  expect(parseFileQuery(" intro.tex:12:3 ")).toMatchObject({
    text: "intro.tex",
    line: 12,
    column: 3,
  });
  // While the number is still being typed.
  expect(parseFileQuery("intro:")).toMatchObject({ text: "intro" });
  expect(parseFileQuery(":8")).toMatchObject({ text: "", line: 8 });
});
