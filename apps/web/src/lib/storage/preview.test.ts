import { expect, test } from "bun:test";

import { hasSourcePreview, imageType, previewType } from "./preview";

test("images and PDFs can be previewed, by extension", () => {
  expect(imageType("figures/Plot.PNG")).toBe("image/png");
  expect(imageType("diagram.svg")).toBe("image/svg+xml");
  expect(imageType("paper.pdf")).toBeUndefined();
  expect(previewType("paper.PDF")).toBe("application/pdf");
  expect(previewType("figure.eps")).toBeUndefined();
  expect(previewType("constructor")).toBeUndefined();
  expect(hasSourcePreview("diagram.SVG")).toBe(true);
  expect(hasSourcePreview("main.tex")).toBe(false);
});
