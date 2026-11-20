import { describe, expect, test } from "bun:test";

import { buildSnapshotSchema } from "@texfolia/contracts";

import {
  parseSyncTex,
  pdfToSource,
  readSyncTex,
  rotatePdfPoint,
  sourceToPdf,
  syncTexArtifact,
} from "./synctex";

const fixture = await Bun.file(
  new URL("../../../test/fixtures/synctex/main.synctex", import.meta.url),
).text();
const paths = ["main.tex", "chapters/one.tex", "appendices/one.tex"];

describe("SyncTeX navigation", () => {
  test("maps real XeTeX output across two pages and same-named project files", () => {
    const index = parseSyncTex(fixture, paths);
    for (const [path, page] of [
      ["chapters/one.tex", 1],
      ["appendices/one.tex", 2],
    ] satisfies [string, number][]) {
      const location = sourceToPdf(index, path, 2);
      expect(location?.page).toBe(page);
      if (!location) throw new Error("Missing fixture source");
      expect(
        pdfToSource(
          index,
          page,
          location.x + location.width / 2,
          location.y + location.height / 2,
        ),
      ).toMatchObject({ path, line: 2 });
    }
    // `synctex view -i 2:1:<source>/appendices/one.tex -o main.pdf`
    // reports h=133.768372, v=191.609436, H=9.075951 (top = v-H).
    const appendix = sourceToPdf(index, "appendices/one.tex", 2);
    expect(appendix?.x).toBeCloseTo(133.768372, 4);
    expect(appendix?.y).toBeCloseTo(182.533485, 4);
    expect(appendix?.height).toBeCloseTo(9.075951, 4);
    expect(pdfToSource(index, 2, 0, 0)).toBeNull();
    expect(sourceToPdf(index, "missing.tex", 1)).toBeNull();
    expect(sourceToPdf(index, "chapters/one.tex", 99)?.path).toBe(
      "chapters/one.tex",
    );
  });

  test("reads plain and gzip artifacts, rejects corrupt and incomplete maps", async () => {
    expect(await readSyncTex(new Blob([fixture]))).toBe(fixture);
    expect(await readSyncTex(new Blob([Bun.gzipSync(fixture)]))).toBe(fixture);
    await expect(
      readSyncTex(new Blob([new Uint8Array([31, 139, 0])])),
    ).rejects.toThrow();
    expect(() => parseSyncTex("not synctex", paths)).toThrow();
    expect(() =>
      parseSyncTex(fixture.split("Postamble:")[0] ?? "", paths),
    ).toThrow();
    expect(() => parseSyncTex(fixture + "Magnification:2\n", paths)).toThrow();
  });

  test("uses preamble units, magnification and offsets", () => {
    const modified = fixture
      .replace("Unit:1", "Unit:2")
      .replace("Magnification:1000", "Magnification:1200")
      .replace("X Offset:0", "X Offset:6578176")
      .replace("Y Offset:0", "Y Offset:3289088");
    const location = sourceToPdf(
      parseSyncTex(modified, paths),
      "appendices/one.tex",
      2,
    );
    expect(location?.x).toBeCloseTo(133.76837287418277 * 2.4 + 200, 4);
    expect(location?.y).toBeCloseTo(182.53348648622355 * 2.4 + 100, 4);
  });

  test("resolves only exact project paths and excludes system inputs", () => {
    expect(() => parseSyncTex(fixture, ["one.tex"])).toThrow();
    const relative = fixture.replaceAll(
      "/private/tmp/texfolia-synctex-fixture/source/./",
      "./",
    );
    expect(
      sourceToPdf(parseSyncTex(relative, paths), "appendices/one.tex", 2)?.page,
    ).toBe(2);
    expect(() =>
      parseSyncTex(
        relative.replaceAll("./appendices/one.tex", "../../appendices/one.tex"),
        ["appendices/one.tex"],
      ),
    ).toThrow();
    expect([...parseSyncTex(fixture, paths).sources.keys()].sort()).toEqual(
      [...paths].sort(),
    );
  });

  test("requires the displayed PDF generation and matching sidecar stem", () => {
    const build = buildSnapshotSchema.parse({
      revision: 2,
      artifacts: {
        id: "saved-build",
        revision: 1,
        digest: "digest",
        builtAt: "now",
        builtBy: "user",
        engine: "tectonic",
        pdf: "main.pdf",
        files: [
          { path: "other.synctex.gz", key: "other", sizeBytes: 1 },
          { path: "main.synctex.gz", key: "saved-map", sizeBytes: 1 },
        ],
      },
    });
    expect(
      syncTexArtifact({ build, pdfBuildId: "streaming-build" }),
    ).toBeNull();
    expect(syncTexArtifact({ build, pdfBuildId: "saved-build" })?.key).toBe(
      "saved-map",
    );
    build.artifacts?.files.pop();
    expect(syncTexArtifact({ build, pdfBuildId: "saved-build" })).toBeNull();
  });

  test("transforms click coordinates through every rotation", () => {
    for (const rotation of [0, 90, 180, 270]) {
      const rendered = rotatePdfPoint(0.2, 0.7, rotation);
      const source = rotatePdfPoint(rendered.x, rendered.y, -rotation);
      expect(source.x).toBeCloseTo(0.2);
      expect(source.y).toBeCloseTo(0.7);
    }
  });
});
