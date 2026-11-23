import { expect, test } from "bun:test";

import * as uiw from "@uiw/codemirror-themes-all";

import {
  appearanceStorageKey,
  catalogTheme,
  resolveTheme,
  themeCatalog,
} from "#/features/editor/themes/themes";

import {
  appearanceSnapshot,
  isAppPath,
  themeBootstrap,
} from "./theme-bootstrap";

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
    "/settings",
    "/settings/preferences",
    "/settings/ai",
    "/project/123",
    "/accept-invitation/123",
  ])
    expect(isAppPath(path)).toBe(true);
  for (const path of ["/", "/pricing", "/docs", "/blog", "/privacy", "/login"])
    expect(isAppPath(path)).toBe(false);
});
