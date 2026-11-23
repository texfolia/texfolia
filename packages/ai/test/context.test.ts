import { describe, expect, test } from "bun:test";

import type { ModelMessage } from "@tanstack/ai";

import { compactHistory, estimateTokens, stubToolResult } from "../src/context";

const big = "x".repeat(40_000);

function turn(index: number, fileText = big): ModelMessage[] {
  const id = `call-${index}`;
  return [
    { role: "user", content: `Question ${index}` },
    {
      role: "assistant",
      content: "",
      thinking: [{ content: "thinking", signature: "sig" }],
      toolCalls: [
        {
          id,
          type: "function",
          function: {
            name: "read_file",
            arguments: JSON.stringify({ path: `main-${index}.tex` }),
          },
        },
      ],
    },
    {
      role: "tool",
      toolCallId: id,
      content: JSON.stringify({
        path: `main-${index}.tex`,
        content: fileText,
        version: `v${index}`,
      }),
    },
    { role: "assistant", content: `Answer ${index}` },
  ];
}

describe("stubToolResult", () => {
  test("replaces read_file contents with the version", () => {
    const stub = JSON.parse(
      stubToolResult(
        "read_file",
        JSON.stringify({ path: "a.tex", content: big, version: "abc" }),
      ),
    );
    expect(stub.path).toBe("a.tex");
    expect(stub.version).toBe("abc");
    expect(stub.content).toContain("version abc");
  });

  test("elides long strings in other results and keeps JSON valid", () => {
    const stub = stubToolResult(
      "git_diff",
      JSON.stringify({ diff: big, status: "ok" }),
    );
    expect(stub.length).toBeLessThan(1000);
    expect(JSON.parse(stub).status).toBe("ok");
  });

  test("keeps small results unchanged", () => {
    const content = JSON.stringify({ path: "a.tex", saved: true });
    expect(stubToolResult("edit_file", content)).toBe(content);
  });
});

describe("compactHistory", () => {
  test("keeps the current turn intact and stubs earlier tool traffic", () => {
    const messages = [...turn(1), ...turn(2)];
    const compacted = compactHistory(messages);
    expect(compacted).toHaveLength(messages.length);
    expect(compacted[2]?.content).not.toContain(big);
    expect(compacted[2]?.content).toContain("version v1");
    expect(compacted[1]?.thinking).toBeUndefined();
    expect(compacted[6]).toEqual(messages[6]!);
    expect(compacted[5]?.thinking).toBeDefined();
  });

  test("bounds input tokens in a long thread", () => {
    const sizes: number[] = [];
    let messages: ModelMessage[] = [];
    for (let index = 0; index < 300; index++) {
      messages = [...messages, ...turn(index, "y".repeat(2_000))];
      messages.push({ role: "assistant", content: "z".repeat(3_000) });
      sizes.push(estimateTokens(compactHistory(messages, 8_000)));
    }
    expect(Math.max(...sizes)).toBeLessThanOrEqual(8_000);
    const compacted = compactHistory(messages, 8_000);
    expect(compacted[0]?.role).toBe("user");
    expect(compacted[0]?.content).toContain("Summary of");
    expect(compacted.at(-1)?.content).toBe("z".repeat(3_000));
  });

  test("keeps the compacted prefix stable across most turns", () => {
    let messages: ModelMessage[] = [];
    let changes = 0;
    let previous: string | undefined;
    for (let index = 0; index < 120; index++) {
      messages = [...messages, ...turn(index, "y".repeat(2_000))];
      const first = JSON.stringify(compactHistory(messages, 8_000)[0]);
      if (previous !== undefined && first !== previous) changes++;
      previous = first;
    }
    expect(changes).toBeLessThan(120 / 4);
  });

  test("drops whole turns so tool calls keep their results", () => {
    const messages = Array.from({ length: 50 }, (_, index) => [
      ...turn(index, "y".repeat(500)),
      { role: "assistant" as const, content: "w".repeat(4_000) },
    ]).flat();
    const compacted = compactHistory(messages, 6_000);
    const calls = new Set(
      compacted.flatMap((m) => m.toolCalls?.map((c) => c.id) ?? []),
    );
    const results = compacted.flatMap((m) =>
      m.role === "tool" ? [m.toolCallId] : [],
    );
    expect(results.every((id) => id && calls.has(id))).toBe(true);
    expect([...calls].every((id) => results.includes(id))).toBe(true);
  });

  test("shrinks an oversized current turn", () => {
    const messages: ModelMessage[] = [
      ...turn(1).slice(0, 3),
      ...turn(2).slice(1, 3),
      ...turn(3).slice(1, 3),
    ];
    const compacted = compactHistory(messages, 12_000);
    expect(estimateTokens(compacted)).toBeLessThanOrEqual(12_000);
    expect(compacted[2]?.content).toContain("version v1");
    expect(compacted.at(-1)?.content).toContain("main-3.tex");
  });

  test("leaves short threads unchanged", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
      { role: "user", content: "Fix the title" },
    ];
    expect(compactHistory(messages)).toEqual(messages);
  });
});
