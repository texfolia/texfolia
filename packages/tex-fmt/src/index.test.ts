import { expect, test } from "bun:test";

import { buildTexFmtConfig, createTexFmt, formatLatex } from "./index.js";

test("serializes typed options to tex-fmt TOML config", () => {
  expect(
    buildTexFmtConfig({
      tabsize: 4,
      usetabs: false,
      wrap: true,
      wraplen: 100,
    }),
  ).toBe('tabsize = 4\ntabchar = "space"\nwrap = true\nwraplen = 100');
});

test("formats LaTeX environments with configured indentation", async () => {
  const source = "\\begin{itemize}\n\\item Hello\n\\end{itemize}\n";
  const result = await formatLatex(source, {
    tabsize: 2,
    wrap: true,
    wraplen: 80,
    usetabs: false,
  });
  expect(result.output).toBe(
    "\\begin{itemize}\n  \\item Hello\n\\end{itemize}\n",
  );
});

test("respects custom tabsize and wrap settings", async () => {
  const source =
    "\\begin{document}\n\\begin{itemize}\n\\item One\n\\end{itemize}\n\\end{document}\n";
  const formatter = createTexFmt();
  const result = await formatter.format(source, {
    tabsize: 4,
    wrap: false,
    usetabs: false,
  });
  expect(result.output).toBe(
    "\\begin{document}\n\\begin{itemize}\n    \\item One\n\\end{itemize}\n\\end{document}\n",
  );
});
