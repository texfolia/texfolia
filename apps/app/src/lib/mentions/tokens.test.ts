import { describe, expect, test } from "bun:test";

import { fileMention, mentionBefore } from "#/lib/ai/editor";

import {
  extractMentionedUserIds,
  formatMentionToken,
  mentionExcerpt,
  mentionQueryBefore,
  parseMentions,
  renderPlainTextMentions,
  sanitizeUnauthorizedMentions,
} from "./tokens";

describe("mention tokens", () => {
  test("formatMentionToken sanitizes brackets and newlines", () => {
    expect(formatMentionToken({ id: "user_1", name: "Ada Lovelace" })).toBe(
      "@[Ada Lovelace](mention:user_1)",
    );
    expect(formatMentionToken({ id: "u2", name: "Bob [Admin]\nJr" })).toBe(
      "@[Bob Admin Jr](mention:u2)",
    );
    expect(formatMentionToken({ id: "u3", name: "   " })).toBe(
      "@[User](mention:u3)",
    );
  });

  test("parseMentions splits text and structured mention tokens", () => {
    const body =
      "Hi @[Ada](mention:u_1), please check @[Grace Hopper](mention:u-2)!";
    expect(parseMentions(body)).toEqual([
      { kind: "text", text: "Hi " },
      {
        kind: "mention",
        userId: "u_1",
        fallbackName: "Ada",
        raw: "@[Ada](mention:u_1)",
        from: 3,
        to: 22,
      },
      { kind: "text", text: ", please check " },
      {
        kind: "mention",
        userId: "u-2",
        fallbackName: "Grace Hopper",
        raw: "@[Grace Hopper](mention:u-2)",
        from: 37,
        to: 65,
      },
      { kind: "text", text: "!" },
    ]);
  });

  test("extractMentionedUserIds deduplicates in order of first appearance", () => {
    const body =
      "@[Ada](mention:u1) and @[Bob](mention:u2) and again @[Ada](mention:u1)";
    expect(extractMentionedUserIds(body)).toEqual(["u1", "u2"]);
  });

  test("sanitizeUnauthorizedMentions downgrades disallowed IDs to plain @Name", () => {
    const body =
      "Allowed @[Ada](mention:u1) and unauthorized @[Mallory](mention:u999)";
    const sanitized = sanitizeUnauthorizedMentions(body, new Set(["u1"]));
    expect(sanitized).toBe(
      "Allowed @[Ada](mention:u1) and unauthorized @Mallory",
    );
    expect(extractMentionedUserIds(sanitized)).toEqual(["u1"]);
  });

  test("mentionQueryBefore matches active @ queries and ignores emails and completed tokens", () => {
    expect(mentionQueryBefore("@")).toEqual({ from: 0, query: "" });
    expect(mentionQueryBefore("Hello @ad")).toEqual({ from: 6, query: "ad" });
    expect(mentionQueryBefore("(@Ada Lo")).toEqual({
      from: 1,
      query: "Ada Lo",
    });
    // Email addresses must not open the picker.
    expect(mentionQueryBefore("mail ada@example.com")).toBeNull();
    // Completed tokens must not reopen the picker.
    expect(mentionQueryBefore("@[Ada](mention:u1)")).toBeNull();
    // Long prose after a stray @ closes the picker.
    expect(mentionQueryBefore("@one two three four")).toBeNull();
  });

  test("renderPlainTextMentions resolves current names and mentionExcerpt truncates", () => {
    const body = "Hey @[Old Name](mention:u1),\n\ncheck this section.";
    const names = new Map([["u1", "New Name"]]);
    expect(
      renderPlainTextMentions(
        body,
        (id, fallback) => names.get(id) ?? fallback,
      ),
    ).toBe("Hey @New Name,\n\ncheck this section.");
    expect(
      mentionExcerpt(body, (id, fallback) => names.get(id) ?? fallback, 20),
    ).toBe("Hey @New Name, chec…");
  });

  test("AI file mentions do not collide with people mention tokens", () => {
    const aiPrompt = `Review ${fileMention("chapters/intro.tex")} and ${fileMention("my notes.md")}`;
    expect(extractMentionedUserIds(aiPrompt)).toEqual([]);
    expect(mentionBefore("Check @chapters/in")).toEqual({
      from: 6,
      query: "chapters/in",
    });
  });
});
