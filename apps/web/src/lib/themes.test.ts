import { expect, test } from "bun:test";

import { ensureSyntaxTree } from "@codemirror/language";
import { highlightTree, tagHighlighter, tags } from "@lezer/highlight";
import { EditorState, type Extension } from "@uiw/react-codemirror";

import { bibtexLanguage, themedLatex } from "./latex/highlight";
import { editorTheme } from "./theme-editor";
import { latexTags, tokenStyle } from "./theme-syntax";
import {
  appearanceSchema,
  appearanceStorageKey,
  bundledThemes,
  parseTheme,
  resolveTheme,
  selectedTheme,
} from "./themes";

test("VS Code JSONC colors drive both app tokens and an editor extension", () => {
  const parsed = parseTheme(`{
    // a standalone color theme
    "name": "Example", "type": "dark",
    "colors": { "editor.background": "#121212", "editor.foreground": "#eee", "sideBar.background": "#222", "button.background": "#07c", "statusBar.background": "#03a", },
    "tokenColors": [{ "scope": "support.function", "settings": { "foreground": "#c0f" } },],
  }`);
  const theme = resolveTheme(parsed);
  expect(theme.mode).toBe("dark");
  expect(theme.variables["--background"]).toBe("#121212");
  expect(theme.variables["--sidebar"]).toBe("#222");
  expect(theme.variables["--primary"]).toBe("#07c");
  expect(theme.variables["--status-background"]).toBe("#03a");
  expect(editorTheme(theme).length).toBeGreaterThan(0);
  expect(theme.variables["--popover"]).toBe("#222");
});

test("imports reject CSS injection, invalid structure, oversized and external files", () => {
  for (const color of [
    "red; background:url(https://evil.test)",
    "var(--secret)",
    "url(x)",
    "#abc;",
    "#12345",
  ])
    expect(() =>
      parseTheme(JSON.stringify({ colors: { "editor.background": color } })),
    ).toThrow("unsupported");
  expect(() =>
    parseTheme('{"tokenColors":[{"settings":{"foreground":"url(x)"}}]}'),
  ).toThrow();
  expect(() =>
    parseTheme(
      '{"colors":{"editor.background":"#fff"},"tokenColors":[{"settings":{"fontStyle":"italic; background:red"}}]}',
    ),
  ).toThrow();
  expect(() => parseTheme('{"include":"base.json"}')).toThrow("includes");
  expect(() => parseTheme('{"tokenColors":"base.tmTheme"}')).toThrow();
  expect(() => parseTheme("{}")).toThrow("No theme colors");
  expect(() => parseTheme(" ".repeat(1024 * 1024 + 1))).toThrow("1 MB");
  expect(() => parseTheme("{oops")).toThrow("valid theme JSON");
});

test("comment and trailing comma handling never rewrites quoted strings", () => {
  const parsed = parseTheme(
    '{"name":"https://example.test/*,}*/", "colors":{"editor.background":"#fff",},}',
  );
  expect(parsed.name).toBe("https://example.test/*,}*/");
});

test("longest dot-prefix selectors resolve each style property, ties choose later rules", () => {
  const result = tokenStyle(
    ["support.function.general.tex"],
    [
      { scope: "support", settings: { foreground: "#111", fontStyle: "bold" } },
      {
        scope: ["support.function", "keyword"],
        settings: { foreground: "#222" },
      },
      {
        scope: "support.function.general",
        settings: { fontStyle: "italic underline" },
      },
      { scope: "support.function", settings: { foreground: "#333" } },
      { scope: "support.fun", settings: { foreground: "#444" } },
    ],
  );
  expect(result).toEqual({
    color: "#333",
    fontStyle: "italic",
    fontWeight: "normal",
    textDecoration: "underline",
  });
  expect(
    tokenStyle(
      ["comment.line.tex"],
      [
        { settings: { foreground: "#aaa", fontStyle: "bold" } },
        { scope: "comment", settings: { fontStyle: "" } },
      ],
    ),
  ).toEqual({
    color: "#aaa",
    fontStyle: "normal",
    fontWeight: "normal",
    textDecoration: "none",
  });
});

test("bundled themes and user-scoped preferences stay valid across system changes", () => {
  for (const definition of Object.values(bundledThemes)) {
    expect(resolveTheme(parseTheme(JSON.stringify(definition))).name).toBe(
      definition.name,
    );
  }
  const appearance = appearanceSchema.parse({ selection: { kind: "system" } });
  expect(selectedTheme(appearance, false)).toBe(bundledThemes.texfolia);
  expect(selectedTheme(appearance, true)).toBe(bundledThemes.vscodeDark);
  expect(appearanceStorageKey("alice")).not.toBe(appearanceStorageKey("bob"));
  expect(
    appearanceSchema.safeParse({
      selection: { kind: "bundled", id: "missing" },
    }).success,
  ).toBe(false);
});

function highlighted(doc: string, extension: Extension) {
  const state = EditorState.create({ doc, extensions: [extension] });
  const tree = ensureSyntaxTree(state, doc.length, 500);
  if (!tree) throw new Error("Parser did not finish");
  const spans: { text: string; style: string }[] = [];
  highlightTree(
    tree,
    tagHighlighter([
      { tag: latexTags.command, class: "command" },
      { tag: latexTags.environment, class: "environment" },
      { tag: latexTags.math, class: "math" },
      { tag: latexTags.argument, class: "argument" },
      { tag: latexTags.option, class: "option" },
      { tag: latexTags.bibField, class: "field" },
      { tag: tags.comment, class: "comment" },
      { tag: tags.string, class: "string" },
    ]),
    (from, to, style) => spans.push({ text: doc.slice(from, to), style }),
  );
  return spans;
}

test("rich LaTeX grammar emits distinct command, environment, math, argument, option and comment tags", () => {
  const spans = highlighted(
    "\\documentclass[letterpaper]{article}\n\\begin{document}\n% Hello\n\\textbf{word} $x+2$\n\\end{document}",
    themedLatex("main.tex"),
  );
  expect(spans).toContainEqual({ text: "\\documentclass", style: "command" });
  expect(spans).toContainEqual({ text: "document", style: "environment" });
  expect(
    spans.some((span) => span.style === "math" && span.text.includes("x")),
  ).toBe(true);
  expect(
    spans.some(
      (span) => span.style === "argument" && span.text.includes("word"),
    ),
  ).toBe(true);
  expect(
    spans.some(
      (span) => span.style === "option" && span.text.includes("letterpaper"),
    ),
  ).toBe(true);
  expect(
    spans.some(
      (span) => span.style === "comment" && span.text.includes("Hello"),
    ),
  ).toBe(true);
});

test("BibTeX field names and nested values are independently themeable", () => {
  const spans = highlighted(
    '@article{key,\n title = {A {nested} title},\n author = "Somebody",\n year = 2026\n}',
    bibtexLanguage,
  );
  expect(spans).toContainEqual({ text: "title", style: "field" });
  expect(spans).toContainEqual({ text: "author", style: "field" });
  expect(
    spans.some(
      (span) => span.style === "string" && span.text.includes("nested"),
    ),
  ).toBe(true);
});

// Run the exact head-script source with a minimal document port. This verifies
// both its escaping and its persisted-color allowlist without a browser.
test("head bootstrap restores the right account and rejects cached CSS injection", async () => {
  const { appearanceSnapshot, themeBootstrap } =
    await import("./theme-bootstrap");
  const custom = resolveTheme(
    parseTheme(
      '{"name":"Imported","type":"dark","colors":{"editor.background":"#123456"}}',
    ),
  );
  const stored = new Map<string, string>([
    [
      appearanceStorageKey("alice"),
      JSON.stringify({
        selection: { kind: "imported" },
        preview: appearanceSnapshot(custom),
      }),
    ],
    [
      appearanceStorageKey("bob"),
      JSON.stringify({ selection: { kind: "system" } }),
    ],
  ]);
  function boot(userId: string, dark: boolean) {
    const values = new Map<string, string>();
    const classes = new Set<string>();
    const document = {
      documentElement: {
        style: {
          colorScheme: "",
          setProperty: (key: string, value: string) => values.set(key, value),
        },
        classList: {
          toggle: (key: string, add: boolean) =>
            add ? classes.add(key) : classes.delete(key),
        },
      },
    };
    new Function(
      "localStorage",
      "matchMedia",
      "document",
      themeBootstrap(userId),
    )(
      { getItem: (key: string) => stored.get(key) ?? null },
      () => ({ matches: dark }),
      document,
    );
    return { values, classes };
  }
  expect(boot("alice", false).values.get("--background")).toBe("#123456");
  expect(boot("alice", false).classes.has("dark")).toBe(true);
  expect(boot("bob", false).values.get("--background")).toBe("#ffffff");
  expect(boot("bob", true).values.get("--background")).toBe("#1e1e1e");
  stored.set(
    appearanceStorageKey("alice"),
    JSON.stringify({
      selection: { kind: "imported" },
      preview: {
        ...appearanceSnapshot(custom),
        variables: {
          ...custom.variables,
          "--background": "url(https://evil.test)",
          "--arbitrary": "#abc",
        },
      },
    }),
  );
  const safe = boot("alice", false);
  expect(safe.values.get("--background")).toBe("#ffffff");
  expect(safe.values.has("--arbitrary")).toBe(false);
  expect(themeBootstrap(null)).toBe("");
  expect(themeBootstrap("</script><script>alert(1)</script>")).not.toContain(
    "</script>",
  );
});

test("long comma-separated selectors used by popular themes remain importable", () => {
  const scope = [
    "support.function.general.tex",
    ...Array.from(
      { length: 60 },
      (_, i) => `entity.name.function.language${i}`,
    ),
  ].join(", ");
  expect(scope.length).toBeGreaterThan(1000);
  const theme = parseTheme(
    JSON.stringify({
      tokenColors: [{ scope, settings: { foreground: "#c678dd" } }],
    }),
  );
  expect(
    tokenStyle(["support.function.general.tex"], theme.tokenColors).color,
  ).toBe("#c678dd");
});

test("only authenticated app paths receive account themes", async () => {
  const { isAppPath } = await import("./theme-bootstrap");
  for (const path of [
    "/projects",
    "/projects/",
    "/project/123",
    "/accept-invitation/123",
  ])
    expect(isAppPath(path)).toBe(true);
  for (const path of ["/", "/pricing", "/docs", "/blog", "/privacy", "/login"])
    expect(isAppPath(path)).toBe(false);
});
