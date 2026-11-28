import { describe, expect, test } from "bun:test";

import { nodeNameSchema } from "@texfolia/contracts";

import { encodeSource, maxSourceFileBytes } from "#/lib/storage";

import type { ProjectNode } from "./paths";
import {
  formatImageSnippet,
  isImageFile,
  uniqueAssetName,
  uploadProjectAssets,
} from "./upload";

const projectId = "00000000-0000-0000-0000-000000000001";
const rootNode: ProjectNode = {
  id: "00000000-0000-0000-0000-000000000010",
  projectId,
  parentId: null,
  name: "/",
  kind: "folder",
};

function makeFile(
  name: string,
  type: string,
  bytes = new Uint8Array([1, 2, 3]),
) {
  return new File([bytes], name, { type });
}

describe("isImageFile", () => {
  test("detects image MIME types and image extensions", () => {
    expect(isImageFile({ name: "blob", type: "image/png" })).toBe(true);
    expect(isImageFile({ name: "photo.jpg", type: "" })).toBe(true);
    expect(isImageFile({ name: "vector.SVG", type: "" })).toBe(true);
    expect(isImageFile({ name: "main.tex", type: "text/plain" })).toBe(false);
    expect(isImageFile({ name: "paper.pdf", type: "application/pdf" })).toBe(
      false,
    );
  });
});

describe("uniqueAssetName", () => {
  test("generates numbered names for generic clipboard screenshots", () => {
    expect(uniqueAssetName([], { name: "image.png", type: "image/png" })).toBe(
      "image-1.png",
    );
    expect(
      uniqueAssetName(["image-1.png"], { name: "", type: "image/png" }),
    ).toBe("image-2.png");
    expect(
      uniqueAssetName(["IMAGE-1.JPG", "image-2.jpg"], {
        name: "blob",
        type: "image/jpeg",
      }),
    ).toBe("image-3.jpg");
  });

  test("preserves sanitized filenames and suffixes on case-insensitive collision", () => {
    expect(
      uniqueAssetName([], {
        name: "System Diagram (v2).png",
        type: "image/png",
      }),
    ).toBe("System-Diagram-(v2).png");
    expect(
      uniqueAssetName(["diagram.png"], {
        name: "Diagram.png",
        type: "image/png",
      }),
    ).toBe("Diagram-2.png");
    expect(
      uniqueAssetName(["diagram.png", "diagram-2.png"], {
        name: "diagram.png",
        type: "image/png",
      }),
    ).toBe("diagram-3.png");
  });

  test("strips characters invalid in nodeNameSchema or LaTeX paths", () => {
    const generated = uniqueAssetName([], {
      name: "bad:name\\with/{braces}#%?.png",
      type: "image/png",
    });
    expect(nodeNameSchema.safeParse(generated).success).toBe(true);
    expect(generated).toBe("bad-name-with-braces.png");
  });

  test("truncates overly long names to stay within the 240-byte path limit", () => {
    const longName = `${"a".repeat(300)}.png`;
    const generated = uniqueAssetName([], {
      name: longName,
      type: "image/png",
    });
    expect(nodeNameSchema.safeParse(generated).success).toBe(true);
    expect(
      new TextEncoder().encode(`figures/${generated}`).length,
    ).toBeLessThanOrEqual(240);
  });
});

describe("formatImageSnippet", () => {
  test("formats LaTeX \\includegraphics snippets", () => {
    expect(
      formatImageSnippet(["figures/image-1.png"], { isMarkdown: false }),
    ).toBe("\\includegraphics[width=\\linewidth]{figures/image-1.png}");
    expect(
      formatImageSnippet(["figures/a.png", "figures/b.jpg"], {
        isMarkdown: false,
      }),
    ).toBe(
      [
        "\\includegraphics[width=\\linewidth]{figures/a.png}",
        "\\includegraphics[width=\\linewidth]{figures/b.jpg}",
      ].join("\n"),
    );
  });

  test("formats Markdown image snippets", () => {
    expect(
      formatImageSnippet(["figures/diagram.png"], { isMarkdown: true }),
    ).toBe("![diagram](figures/diagram.png)");
  });
});

describe("uploadProjectAssets", () => {
  test("creates figures/ on first use and uploads with unique names", async () => {
    const created: Array<{
      parentId: string;
      name: string;
      kind: string;
      content?: string;
    }> = [];
    let counter = 1;
    const files = {
      create: async (input: {
        parentId: string;
        name: string;
        kind: "folder" | "text" | "binary";
        content?: string;
      }) => {
        created.push(input);
        return {
          id: `00000000-0000-0000-0000-00000000010${counter++}`,
          projectId,
          parentId: input.parentId,
          name: input.name,
          kind: input.kind,
        };
      },
    };

    const bytes1 = new Uint8Array([10, 20, 30]);
    const bytes2 = new Uint8Array([40, 50, 60]);
    const paths = await uploadProjectAssets({
      files,
      nodes: [rootNode],
      imageFiles: [
        makeFile("image.png", "image/png", bytes1),
        makeFile("chart.png", "image/png", bytes2),
      ],
    });

    expect(paths).toEqual(["figures/image-1.png", "figures/chart.png"]);
    expect(created).toEqual([
      { parentId: rootNode.id, name: "figures", kind: "folder" },
      {
        parentId: "00000000-0000-0000-0000-000000000101",
        name: "image-1.png",
        kind: "binary",
        content: encodeSource(bytes1),
      },
      {
        parentId: "00000000-0000-0000-0000-000000000101",
        name: "chart.png",
        kind: "binary",
        content: encodeSource(bytes2),
      },
    ]);
  });

  test("rejects oversized files before creating any folder or node", async () => {
    const created: unknown[] = [];
    const oversized = {
      name: "huge.png",
      type: "image/png",
      size: maxSourceFileBytes + 1,
      arrayBuffer: async () => new ArrayBuffer(0),
    } as File;

    await expect(
      uploadProjectAssets({
        files: {
          create: async (input) => {
            created.push(input);
            return {
              id: "id",
              projectId,
              parentId: input.parentId,
              name: input.name,
              kind: input.kind,
            };
          },
        },
        nodes: [rootNode],
        imageFiles: [oversized],
      }),
    ).rejects.toThrow(/exceeds 10 MiB/);
    expect(created).toHaveLength(0);
  });

  test("reuses an existing image node with identical SHA-256 bytes", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const hash = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const figuresFolder: ProjectNode = {
      id: "00000000-0000-0000-0000-000000000020",
      projectId,
      parentId: rootNode.id,
      name: "figures",
      kind: "folder",
    };
    const existingImage: ProjectNode = {
      id: "00000000-0000-0000-0000-000000000021",
      projectId,
      parentId: figuresFolder.id,
      name: "existing.png",
      kind: "binary",
    };
    const created: unknown[] = [];

    const paths = await uploadProjectAssets({
      files: {
        create: async (input) => {
          created.push(input);
          return {
            id: "new-id",
            projectId,
            parentId: input.parentId,
            name: input.name,
            kind: input.kind,
          };
        },
        sourceVersions: {
          [existingImage.id]: {
            objectKey: `projects/${projectId}/sources/uuid-${hash}`,
          },
        },
      },
      nodes: [rootNode, figuresFolder, existingImage],
      imageFiles: [makeFile("image.png", "image/png", bytes)],
    });

    expect(paths).toEqual(["figures/existing.png"]);
    expect(created).toHaveLength(0);
  });
});
