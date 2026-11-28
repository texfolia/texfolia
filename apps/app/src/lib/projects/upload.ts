import {
  maxSourcePathBytes,
  nodeNameSchema,
  pathBytes,
} from "@texfolia/contracts";

import {
  encodeSource,
  maxSourceFileBytes,
  sourceFileKind,
  sourceHashFromKey,
} from "#/lib/storage";
import type { DroppedFile } from "#/lib/storage/browser";

import {
  newProjectNodePath,
  projectNodePaths,
  type ProjectNode,
} from "./paths";

export const defaultAssetFolder = "figures";

const imageMimeExtensions = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/jpg", "jpg"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
  ["image/svg+xml", "svg"],
  ["image/bmp", "bmp"],
  ["image/tiff", "tiff"],
  ["image/avif", "avif"],
  ["image/x-icon", "ico"],
]);

const imageFileExtension = /\.(png|jpe?g|gif|webp|bmp|tiff?|svg|avif|ico)$/i;

const genericImageStem =
  /^(?:image|blob|clipboard|pasted[-_ ]?image|screenshot)$/i;

export function isImageFile(file: Pick<File, "name" | "type">): boolean {
  return (
    file.type.toLowerCase().startsWith("image/") ||
    imageFileExtension.test(file.name)
  );
}

export function extensionForImage(file: Pick<File, "name" | "type">): string {
  const fromMime = imageMimeExtensions.get(
    file.type.toLowerCase().split(";")[0]?.trim() ?? "",
  );
  if (fromMime) return fromMime;
  const fromName = imageFileExtension.exec(file.name)?.[1]?.toLowerCase();
  if (fromName) return fromName === "jpeg" ? "jpg" : fromName;
  return "png";
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (pathBytes(value) <= maxBytes) return value;
  let result = "";
  for (const char of value) {
    if (pathBytes(result + char) > maxBytes) break;
    result += char;
  }
  return result.replace(/-+$/, "");
}

/**
 * Generates a unique, readable asset filename valid per `nodeNameSchema` that
 * never collides with `existingNames` (case-insensitively).
 */
export function uniqueAssetName(
  existingNames: Iterable<string>,
  file: Pick<File, "name" | "type">,
  folderPrefix = defaultAssetFolder,
): string {
  const used = new Set([...existingNames].map((name) => name.toLowerCase()));
  const ext = extensionForImage(file);
  const dot = file.name.lastIndexOf(".");
  const rawStem = dot > 0 ? file.name.slice(0, dot) : file.name;
  // Strip characters rejected by nodeNameSchema or awkward in LaTeX paths.
  const sanitized = rawStem
    .trim()
    // oxlint-disable-next-line no-control-regex -- Strip control chars from filenames.
    .replace(/[\\/:*?"<>|\u0000-\u001f\s{}#%~$^&]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");

  const isGeneric =
    !sanitized ||
    sanitized === "." ||
    sanitized === ".." ||
    genericImageStem.test(sanitized);

  // Reserve space for the folder prefix, slash, optional "-9999" suffix, and ".ext".
  const prefixBytes = folderPrefix ? pathBytes(`${folderPrefix}/`) : 0;
  const maxStemBytes = Math.max(
    8,
    maxSourcePathBytes - prefixBytes - pathBytes(`.${ext}`) - 8,
  );
  const baseStem = isGeneric
    ? "image"
    : truncateUtf8(sanitized, maxStemBytes) || "image";

  let candidate: string;
  if (isGeneric) {
    let index = 1;
    do {
      candidate = `${baseStem}-${index}.${ext}`;
      index++;
    } while (used.has(candidate.toLowerCase()));
  } else {
    candidate = `${baseStem}.${ext}`;
    if (used.has(candidate.toLowerCase())) {
      let index = 2;
      do {
        candidate = `${baseStem}-${index}.${ext}`;
        index++;
      } while (used.has(candidate.toLowerCase()));
    }
  }
  return nodeNameSchema.parse(candidate);
}

/** Formats uploaded asset paths for insertion into a LaTeX or Markdown editor. */
export function formatImageSnippet(
  paths: readonly string[],
  options: { isMarkdown: boolean },
): string {
  return paths
    .map((assetPath) => {
      if (options.isMarkdown) {
        const filename = assetPath.slice(assetPath.lastIndexOf("/") + 1);
        const alt = filename.replace(/\.[^/.]+$/, "");
        return `![${alt}](${assetPath})`;
      }
      return `\\includegraphics[width=\\linewidth]{${assetPath}}`;
    })
    .join("\n");
}

export type ProjectNodeCreator = {
  create: (input: {
    parentId: string;
    name: string;
    kind: "folder" | "text" | "binary";
    content?: string;
  }) => Promise<ProjectNode>;
  sourceVersions?: Readonly<Record<string, { objectKey: string | null }>>;
};

/**
 * Validates and uploads dropped/selected files into `targetParentId`, merging
 * dropped folders into existing ones and rejecting collisions.
 */
export async function uploadProjectFiles({
  files,
  nodes,
  targetParentId,
  dropped,
}: {
  files: ProjectNodeCreator;
  nodes: readonly ProjectNode[];
  targetParentId: string;
  dropped: readonly DroppedFile[];
}): Promise<ProjectNode[]> {
  // Validate every path before creating anything, so a bad drop leaves
  // the tree unchanged. Dropped folders merge into existing ones.
  const planned: Pick<ProjectNode, "id" | "parentId" | "name" | "kind">[] = [
    ...nodes,
  ];
  const steps: {
    id: string;
    parentId: string;
    name: string;
    file?: File;
  }[] = [];
  for (const { path, file } of dropped) {
    if (file.size > maxSourceFileBytes)
      throw new Error(
        `${path.join("/")} exceeds 10 MiB. Choose a smaller file.`,
      );
    let parent = targetParentId;
    for (const [index, name] of path.entries()) {
      const last = index === path.length - 1;
      const existing = planned.find(
        (node) =>
          node.parentId === parent &&
          node.name.toLowerCase() === name.toLowerCase(),
      );
      if (existing?.kind === "folder" && !last) {
        parent = existing.id;
        continue;
      }
      if (existing)
        throw new Error(
          `${path.slice(0, index + 1).join("/")}: A file or folder with this name already exists here.`,
        );
      newProjectNodePath(planned, parent, name);
      const id = crypto.randomUUID();
      planned.push({
        id,
        parentId: parent,
        name,
        kind: last ? "binary" : "folder",
      });
      steps.push({
        id,
        parentId: parent,
        name,
        file: last ? file : undefined,
      });
      parent = id;
    }
  }
  const created = new Map<string, ProjectNode>();
  const uploadedFiles: ProjectNode[] = [];
  for (const step of steps) {
    const parentId = created.get(step.parentId)?.id ?? step.parentId;
    const node = await files.create(
      step.file
        ? {
            parentId,
            name: step.name,
            kind: sourceFileKind(step.file),
            content: encodeSource(
              new Uint8Array(await step.file.arrayBuffer()),
            ),
          }
        : { parentId, name: step.name, kind: "folder" },
    );
    created.set(step.id, node);
    if (step.file) uploadedFiles.push(node);
  }
  return uploadedFiles;
}

async function sha256Hex(bytes: Uint8Array): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Uploads pasted or dropped image files into the project's assets folder
 * (creating it on first use) with collision-free names. Reuses an existing
 * image file when its SHA-256 content hash matches.
 */
export async function uploadProjectAssets({
  files,
  nodes,
  imageFiles,
  folderName = defaultAssetFolder,
}: {
  files: ProjectNodeCreator;
  nodes: readonly ProjectNode[];
  imageFiles: readonly File[];
  folderName?: string;
}): Promise<string[]> {
  if (!imageFiles.length) return [];

  const root = nodes.find(
    (node) => node.kind === "folder" && node.parentId === null,
  );
  if (!root) throw new Error("Project root folder not found.");

  // Validate sizes before creating any folder or node.
  for (const file of imageFiles) {
    if (file.size > maxSourceFileBytes)
      throw new Error(
        `${file.name || "Image"} exceeds 10 MiB. Choose a smaller file.`,
      );
  }

  const nodePaths = projectNodePaths([...nodes]);
  const existingByHash = new Map<string, string>();
  if (files.sourceVersions) {
    for (const node of nodes) {
      if (node.kind === "folder") continue;
      const assetPath = nodePaths.get(node.id);
      if (!assetPath || !imageFileExtension.test(assetPath)) continue;
      const hash = sourceHashFromKey(files.sourceVersions[node.id]?.objectKey);
      if (hash && !existingByHash.has(hash))
        existingByHash.set(hash, assetPath);
    }
  }

  const prepared = await Promise.all(
    imageFiles.map(async (file) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const hash = await sha256Hex(bytes);
      return { file, bytes, hash };
    }),
  );

  // Locate or lazily create the assets folder only if at least one file needs uploading.
  const needsUpload = prepared.some(
    ({ hash }) => !hash || !existingByHash.has(hash),
  );
  let targetFolderId: string | undefined;
  let resolvedFolderName = folderName;
  const usedNames = new Set<string>();

  if (needsUpload) {
    const rootChildren = nodes.filter((node) => node.parentId === root.id);
    const existingFolder = rootChildren.find(
      (node) =>
        node.kind === "folder" &&
        node.name.toLowerCase() === folderName.toLowerCase(),
    );
    if (existingFolder) {
      targetFolderId = existingFolder.id;
      resolvedFolderName = existingFolder.name;
      for (const child of nodes)
        if (child.parentId === existingFolder.id) usedNames.add(child.name);
    } else {
      const rootNames = new Set(
        rootChildren.map((node) => node.name.toLowerCase()),
      );
      if (rootNames.has(resolvedFolderName.toLowerCase())) {
        let index = 2;
        while (rootNames.has(`${folderName}-${index}`.toLowerCase())) index++;
        resolvedFolderName = `${folderName}-${index}`;
      }
      const createdFolder = await files.create({
        parentId: root.id,
        name: resolvedFolderName,
        kind: "folder",
      });
      targetFolderId = createdFolder.id;
    }
  }

  const results: string[] = [];
  for (const { file, bytes, hash } of prepared) {
    const reused = hash ? existingByHash.get(hash) : undefined;
    if (reused) {
      results.push(reused);
      continue;
    }
    const name = uniqueAssetName(usedNames, file, resolvedFolderName);
    usedNames.add(name);
    await files.create({
      parentId: targetFolderId!,
      name,
      kind: sourceFileKind({ name, type: file.type }),
      content: encodeSource(bytes),
    });
    const assetPath = `${resolvedFolderName}/${name}`;
    if (hash) existingByHash.set(hash, assetPath);
    results.push(assetPath);
  }
  return results;
}
