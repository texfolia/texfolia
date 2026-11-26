import { expect, test } from "bun:test";

import { ensureSyntaxTree, highlightingFor } from "@codemirror/language";
import { highlightTree, tagHighlighter, tags } from "@lezer/highlight";
import {
  bibtexLanguage,
  latex,
  latexTags,
} from "@texfolia/codemirror-lang-latex";
import * as uiw from "@uiw/codemirror-themes-all";
import { EditorState, EditorView, type Extension } from "@uiw/react-codemirror";

import { renderThemeCatalog } from "../../../../scripts/generate-theme-catalog";
import {
  appearanceSchema,
  defaultAppearance,
  migrateAppearance,
  selectedTheme,
} from "./appearance";
import { editorTheme } from "./theme-editor";
import { loadedThemeExtension, loadThemeExtension } from "./theme-extensions";
import {
  appearanceStorageKey,
  catalogTheme,
  legacyAppearanceStorageKey,
  resolveTheme,
  themeCatalog,
} from "./themes";

test("generated theme catalog is current", async () => {
  for (const [path, text] of Object.entries(await renderThemeCatalog()))
    expect(await Bun.file(path).text()).toBe(text);
});

test("catalog includes exactly every exported UIW theme with its native settings and mode", async () => {
  const ids = Object.keys(uiw)
    .filter((key) => key.endsWith("Init"))
    .map((key) => key.slice(0, -4))
    .sort();
  expect(ids).toEqual(themeCatalog.map((theme) => theme.id).sort());
  expect(new Set(themeCatalog.map((theme) => theme.id)).size).toBe(ids.length);
  for (const definition of themeCatalog) {
    const resolved = resolveTheme(definition);
    const loaded = await loadThemeExtension(definition.id);
    expect(loaded).toBe(uiw[definition.id]);
    expect(loadedThemeExtension(definition.id)).toBe(loaded);
    const extension = editorTheme(resolved, loaded);
    expect(resolved.variables["--background"]).toBe(
      definition.settings.background,
    );
    expect(resolved.variables["--foreground"]).toBe(
      definition.settings.foreground,
    );
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

test("native UIW highlighting handles the inherited LaTeX tags", async () => {
  const state = EditorState.create({
    extensions: editorTheme(
      resolveTheme(catalogTheme("dracula")),
      await loadThemeExtension("dracula"),
    ),
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
  expect(selectedTheme(defaultAppearance.selection, false).id).toBe(
    "githubLight",
  );
  expect(selectedTheme(defaultAppearance.selection, true).id).toBe(
    "githubDark",
  );
  expect(appearanceStorageKey("alice")).not.toBe(appearanceStorageKey("bob"));
  expect(appearanceStorageKey("alice")).not.toBe(
    legacyAppearanceStorageKey("alice"),
  );
  const saved = {
    selection: { kind: "theme", id: "dracula" },
    pdfMode: "match",
  } satisfies import("./appearance").Appearance;
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
    latex({ enableAutocomplete: false, enableLinting: false }),
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

test("theme metadata loads neither CodeMirror nor Zod, which every page would load", async () => {
  const build = await Bun.build({
    entrypoints: [
      new URL("../../theme/theme-bootstrap.ts", import.meta.url).pathname,
    ],
    target: "browser",
    metafile: true,
  });
  const inputs = Object.keys(build.metafile?.inputs ?? {});
  expect(inputs.some((input) => input.endsWith("themes.ts"))).toBe(true);
  expect(inputs.filter((input) => input.includes("node_modules"))).toEqual([]);
});

/** WCAG contrast of two hex colors. */
function contrast(a: string, b: string) {
  const luminance = (color: string) => {
    const hex = color.slice(1);
    const digits = hex.length < 6 ? hex.replace(/./g, "$&$&") : hex;
    const [red, green, blue] = [0, 2, 4].map((at) => {
      const value = parseInt(digits.slice(at, at + 2), 16) / 255;
      return value <= 0.03928
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
  };
  const [low, high] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (high! + 0.05) / (low! + 0.05);
}

test("status colors stand out from every theme's background", () => {
  for (const definition of themeCatalog) {
    const { variables } = resolveTheme(definition);
    for (const name of ["--success", "--warning", "--info"] as const)
      // WCAG 1.4.11, for graphics such as a compile's status dot.
      expect({
        theme: definition.id,
        name,
        visible: contrast(variables[name], definition.settings.background) >= 3,
      }).toEqual({ theme: definition.id, name, visible: true });
  }
});
