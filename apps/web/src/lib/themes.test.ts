import { expect, test } from "bun:test";

import { ensureSyntaxTree, highlightingFor } from "@codemirror/language";
import { highlightTree, tagHighlighter, tags } from "@lezer/highlight";
import * as uiw from "@uiw/codemirror-themes-all";
import { EditorState, EditorView, type Extension } from "@uiw/react-codemirror";

import { bibtexLanguage, themedLatex } from "./latex/highlight";
import { latexTags } from "./latex/tags";
import {
  appearanceSnapshot,
  themeBootstrap,
  isAppPath,
} from "./theme-bootstrap";
import { editorTheme } from "./theme-editor";
import {
  appearanceSchema,
  appearanceStorageKey,
  legacyAppearanceStorageKey,
  themeCatalog,
  catalogTheme,
  migrateAppearance,
  defaultAppearance,
  resolveTheme,
  selectedTheme,
} from "./themes";

test("catalog includes exactly every exported UIW theme with its native settings and mode", () => {
  const ids = Object.keys(uiw)
    .filter((key) => key.endsWith("Init"))
    .map((key) => key.slice(0, -4))
    .sort();
  expect(ids).toEqual(themeCatalog.map((theme) => theme.id).sort());
  expect(new Set(themeCatalog.map((theme) => theme.id)).size).toBe(ids.length);
  for (const definition of themeCatalog) {
    const resolved = resolveTheme(definition);
    const extension = editorTheme(resolved);
    expect(resolved.variables["--background"]).toBe(
      definition.settings.background,
    );
    expect(resolved.variables["--foreground"]).toBe(
      definition.settings.foreground,
    );
    expect(definition.extension).toBe(uiw[definition.id]);
    expect(
      EditorState.create({ extensions: extension }).facet(EditorView.darkTheme),
    ).toBe(definition.mode === "dark");
  }
  const dracula = resolveTheme(catalogTheme("dracula"));
  expect(uiw.defaultSettingsDracula).toEqual(dracula.settings);
  expect(uiw.defaultSettingsDracula.selection).toBe(
    dracula.variables["--selection"],
  );
  expect(uiw.defaultSettingsDracula.caret).toBe(dracula.variables["--ring"]);
  expect(dracula.variables["--sidebar"]).toContain(
    uiw.defaultSettingsDracula.background!,
  );
  expect(resolveTheme(catalogTheme("basicDark")).variables["--border"]).toBe(
    "#ffffff10",
  );
  expect(
    resolveTheme(catalogTheme("basicLight")).variables["--border"],
  ).not.toBe("none");
});

test("native UIW highlighting handles the inherited LaTeX tags", () => {
  const state = EditorState.create({
    extensions: editorTheme(resolveTheme(catalogTheme("dracula"))),
  });
  expect(highlightingFor(state, [latexTags.command])).toBe(
    highlightingFor(state, [tags.keyword]),
  );
  expect(highlightingFor(state, [latexTags.argument])).toBe(
    highlightingFor(state, [tags.string]),
  );
  expect(highlightingFor(state, [latexTags.command])).not.toBeNull();
});

test("appearance v2 is account-scoped, follows GitHub system modes, and has no import variant", () => {
  expect(selectedTheme(defaultAppearance, false).id).toBe("githubLight");
  expect(selectedTheme(defaultAppearance, true).id).toBe("githubDark");
  expect(appearanceStorageKey("alice")).not.toBe(appearanceStorageKey("bob"));
  expect(appearanceStorageKey("alice")).not.toBe(
    legacyAppearanceStorageKey("alice"),
  );
  const saved = {
    selection: { kind: "theme", id: "dracula" },
    pdfMode: "match",
  } satisfies import("./themes").Appearance;
  expect(appearanceSchema.parse(JSON.parse(JSON.stringify(saved)))).toEqual(
    saved,
  );
  expect(
    appearanceSchema.safeParse({ selection: { kind: "imported", theme: {} } })
      .success,
  ).toBe(false);
  expect(
    appearanceSchema.safeParse({ selection: { kind: "theme", id: "missing" } })
      .success,
  ).toBe(false);
});

test("migration keeps surviving ids and PDF mode, and defaults imported or removed themes", () => {
  for (const selection of [
    { kind: "imported", theme: { name: "Old" } },
    { kind: "bundled", id: "texfolia" },
    { kind: "bundled", id: "oneDark" },
    { kind: "theme", id: "removed" },
  ]) {
    expect(migrateAppearance({ selection, pdfMode: "match" })).toEqual({
      selection: { kind: "system" },
      pdfMode: "match",
    });
  }
  expect(
    migrateAppearance({
      selection: { kind: "bundled", id: "dracula" },
      pdfMode: "match",
    }),
  ).toEqual({ selection: { kind: "theme", id: "dracula" }, pdfMode: "match" });
  expect(migrateAppearance(null)).toEqual(defaultAppearance);
  expect(migrateAppearance({ selection: { kind: "system" } })).toEqual(
    defaultAppearance,
  );
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

function boot({
  raw,
  dark = false,
  userId = "alice",
  unavailable = false,
}: {
  raw: unknown;
  dark?: boolean;
  userId?: string;
  unavailable?: boolean;
}) {
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
    {
      getItem: (key: string) => {
        if (unavailable) throw new Error("Unavailable");
        return key === appearanceStorageKey("alice")
          ? JSON.stringify(raw)
          : null;
      },
    },
    () => ({ matches: dark }),
    document,
  );
  return { values, classes };
}

test("bootstrap accepts every catalog snapshot including rgba and transparent", () => {
  for (const definition of themeCatalog) {
    const theme = resolveTheme(definition);
    const result = boot({
      raw: {
        selection: { kind: "theme", id: definition.id },
        preview: appearanceSnapshot(theme),
      },
      dark: definition.mode !== "dark",
    });
    expect(Object.fromEntries(result.values)).toEqual(theme.variables);
    expect(result.classes.has("dark")).toBe(theme.mode === "dark");
  }
  const theme = resolveTheme(catalogTheme("dracula"));
  const result = boot({
    raw: {
      selection: { kind: "theme", id: "dracula" },
      preview: {
        ...appearanceSnapshot(theme),
        variables: { ...theme.variables, "--selection": "transparent" },
      },
    },
  });
  expect(result.values.get("--selection")).toBe("transparent");
});

test("bootstrap rejects unsafe CSS, unknown selections, and invalid snapshots", () => {
  const theme = resolveTheme(catalogTheme("dracula"));
  for (const color of [
    "url(https://evil.test)",
    "#fff; background:red",
    "var(--secret)",
    "rgba(0,0,0,1); color:red",
    "color-mix(in srgb, #fff 10%, url(x))",
    "#12345",
    "expression(alert(1))",
  ]) {
    const result = boot({
      raw: {
        selection: { kind: "theme", id: "dracula" },
        preview: {
          ...appearanceSnapshot(theme),
          variables: {
            ...theme.variables,
            "--background": color,
            "--arbitrary": "#abc",
          },
        },
      },
    });
    expect(result.values.get("--background")).toBe(
      uiw.defaultSettingsGithubLight.background,
    );
    expect(result.values.has("--arbitrary")).toBe(false);
  }
  for (const selection of [
    { kind: "theme", id: "missing" },
    { kind: "imported" },
    { kind: "system" },
  ]) {
    expect(
      boot({
        raw: { selection, preview: appearanceSnapshot(theme) },
      }).values.get("--background"),
    ).toBe(uiw.defaultSettingsGithubLight.background);
  }
  expect(boot({ raw: null, dark: true }).values.get("--background")).toBe(
    uiw.defaultSettingsGithubDark.background,
  );
  expect(
    boot({ raw: null, unavailable: true }).values.get("--background"),
  ).toBe(uiw.defaultSettingsGithubLight.background);
  expect(
    boot({
      raw: {
        selection: { kind: "theme", id: "dracula" },
        preview: appearanceSnapshot(theme),
      },
      userId: "bob",
    }).values.get("--background"),
  ).toBe(uiw.defaultSettingsGithubLight.background);
  expect(themeBootstrap(null)).toBe("");
  expect(themeBootstrap("</script><script>alert(1)</script>")).not.toContain(
    "</script>",
  );
});

test("only authenticated app paths receive account themes", () => {
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
