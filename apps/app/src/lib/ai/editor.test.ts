import { expect, test } from "bun:test";

import {
  fileMention,
  mentionBefore,
  problemPrompt,
  selectionPrompt,
} from "./editor";

test("mentions quote paths with spaces", () => {
  expect(fileMention("chapters/intro.tex")).toBe("@chapters/intro.tex");
  expect(fileMention("my notes.tex")).toBe('@"my notes.tex"');
});

test("a mention is completed only where one starts", () => {
  expect(mentionBefore("Fix @")).toEqual({ from: 4, query: "" });
  expect(mentionBefore("@chap")).toEqual({ from: 0, query: "chap" });
  expect(mentionBefore('See (@"my no')).toEqual({ from: 5, query: "my no" });
  expect(mentionBefore("me@example")).toBeNull();
  expect(mentionBefore("@intro.tex ")).toBeNull();
  expect(mentionBefore('@"my notes.tex"')).toBeNull();
  expect(mentionBefore("no mention")).toBeNull();
});

test("prompts name the file and its lines", () => {
  expect(selectionPrompt("a.tex", { text: "x", from: 2, to: 2 })).toBe(
    "About @a.tex, line 2:\n\n```\nx\n```\n\n",
  );
  expect(
    selectionPrompt("a.md", { text: "```\ncode\n```", from: 1, to: 3 }),
  ).toContain("lines 1–3:\n\n````\n```\ncode\n```\n````");
  expect(
    selectionPrompt("a.tex", { text: "x".repeat(40_000), from: 1, to: 9 })
      .length,
  ).toBeLessThan(9000);
  expect(
    problemPrompt({ path: "a.tex", line: 4, message: "Undefined command" }),
  ).toBe("Fix this problem in @a.tex, line 4: Undefined command");
});
