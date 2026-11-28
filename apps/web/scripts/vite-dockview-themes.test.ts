import { expect, test } from "bun:test";

import { withoutThemes } from "./vite-dockview-themes";

test("drops Dockview's bundled themes and keeps everything else", async () => {
  const css = await Bun.file(
    Bun.resolveSync("dockview-react/dist/styles/dockview.css", import.meta.dir),
  ).text();
  const stripped = withoutThemes(css);
  expect(stripped).not.toContain("dockview-theme-");
  expect(stripped).toContain(".dv-groupview");
  expect(stripped).toContain("@media (pointer: coarse)");
  expect(stripped.length).toBeLessThan(css.length / 2);
});
