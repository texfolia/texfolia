export type SyncTexLocation = {
  path: string;
  line: number;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
};
export type SyncTexIndex = {
  pages: ReadonlyMap<number, SyncTexLocation[]>;
  sources: ReadonlyMap<string, SyncTexLocation[]>;
};

// The compiler runs in <temporary root>/source; never resolve by basename.
function sourcePath(input: string) {
  const relative = input.replace(/^.*\/texfolia-[^/]+\/source\//, "");
  if (relative.startsWith("/")) return null;
  const parts: string[] = [];
  for (const part of relative.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}

export function syncTexArtifact({
  build,
  pdfBuildId,
}: {
  build: BuildSnapshot | null;
  pdfBuildId: string | null;
}) {
  const artifacts = build?.artifacts;
  if (!artifacts?.pdf || artifacts.id !== pdfBuildId) return null;
  const stem = artifacts.pdf.replace(/\.pdf$/i, "");
  return (
    artifacts.files.find((file) => file.path === `${stem}.synctex.gz`) ??
    artifacts.files.find((file) => file.path === `${stem}.synctex`) ??
    null
  );
}

export async function readSyncTex(blob: Blob) {
  const signature = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  const stream =
    signature[0] === 0x1f && signature[1] === 0x8b
      ? blob.stream().pipeThrough(new DecompressionStream("gzip"))
      : blob.stream();
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 32 * 1024 * 1024) throw new Error("SyncTeX file is too large");
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel();
  }
}

// SyncTeX v1 coordinates are scaled TeX points, measured from the page's top
// left. Convert to PDF points using the reference parser's preamble transform:
// https://github.com/jlaurens/synctex/blob/main/synctex_parser.c
export function parseSyncTex(
  text: string,
  projectPaths: Iterable<string>,
): SyncTexIndex {
  if (!/^SyncTeX Version:1\r?\n/.test(text))
    throw new Error("Unsupported SyncTeX file");
  const paths = new Set(projectPaths);
  const inputs = new Map<number, string>();
  const pages = new Map<number, SyncTexLocation[]>();
  const sources = new Map<string, SyncTexLocation[]>();
  const textSources = new Map<string, SyncTexLocation[]>();
  const boxes: {
    height: number;
    depth: number;
    previous: number;
  }[] = [];
  let unit = 1;
  let magnification = 1000;
  let offsetX = 0;
  let offsetY = 0;
  let page = 0;
  let content = false;
  let finished = false;
  let count = 0;
  let lastY = 0;
  for (const record of text.split(/\r?\n/)) {
    const input = /^Input:(\d+):(.+)$/.exec(record);
    if (input) {
      const path = sourcePath(input[2]!);
      if (path && paths.has(path)) inputs.set(Number(input[1]), path);
      continue;
    }
    if (!content) {
      const header = /^(Unit|Magnification|X Offset|Y Offset):(-?\d+)$/.exec(
        record,
      );
      if (header) {
        const value = Number(header[2]);
        switch (header[1]) {
          case "Unit":
            unit = value;
            break;
          case "Magnification":
            magnification = value;
            break;
          case "X Offset":
            offsetX = value;
            break;
          case "Y Offset":
            offsetY = value;
            break;
        }
      }
      if (record === "Content:") content = true;
      continue;
    }
    if (record === "Postamble:") {
      finished = true;
      page = 0;
      continue;
    }
    // Unsupported transformations and forms disable this optional map rather
    // than offer navigation using coordinates we cannot interpret.
    if (/^[<f]|^(Magnification|X Offset|Y Offset):/.test(record))
      throw new Error("Unsupported SyncTeX transformation");
    if (record.startsWith("{")) {
      page = Number(record.slice(1));
      boxes.length = 0;
      continue;
    }
    if (record.startsWith("}")) {
      page = 0;
      continue;
    }
    if (!page) continue;
    if (record === ")" || record === "]") {
      boxes.pop();
      continue;
    }
    const node =
      /^([[(hvkgxr$])\s*(\d+),(\d+)(?:,-?\d+)?:([-\d]+),([-\d]+|=)(?::(-?\d+)(?:,(-?\d+),(-?\d+))?)?$/.exec(
        record,
      );
    if (!node) continue;
    const kind = node[1];
    const x = Number(node[4]);
    const y = node[5] === "=" ? lastY : Number(node[5]);
    lastY = y;
    const parent = boxes.at(-1);
    const width = Number(node[6] ?? 0);
    const height = Number(node[7] ?? parent?.height ?? 0);
    const depth = Number(node[8] ?? parent?.depth ?? 0);
    if (kind === "[" || kind === "(") {
      boxes.push({ height, depth, previous: x });
      continue;
    }
    const previous = parent?.previous ?? x;
    if (parent) parent.previous = x;
    const path = inputs.get(Number(node[2]));
    const line = Number(node[3]);
    if (!path || line < 1 || height + depth <= 0) continue;
    const left = kind === "k" ? x - width : width ? x : Math.min(previous, x);
    const right = kind === "k" ? x : width ? x + width : Math.max(previous, x);
    const factor = (unit * magnification) / 1000 / 65781.76;
    const location = {
      path,
      line,
      page,
      x: Math.min(left, right) * factor + (offsetX * unit) / 65781.76,
      y: (y - height) * factor + (offsetY * unit) / 65781.76,
      width: Math.abs(right - left) * factor,
      height: (height + depth) * factor,
    };
    if (
      !Object.values(location).every(
        (value) => typeof value !== "number" || Number.isFinite(value),
      )
    )
      throw new Error("Invalid SyncTeX coordinates");
    const pageLocations = pages.get(page) ?? [];
    pageLocations.push(location);
    pages.set(page, pageLocations);
    const sourceLocations = sources.get(path) ?? [];
    sourceLocations.push(location);
    sources.set(path, sourceLocations);
    if (kind === "g" && location.width > 0) {
      const textLocations = textSources.get(path) ?? [];
      textLocations.push(location);
      textSources.set(path, textLocations);
    }
    if (++count > 250_000)
      throw new Error("SyncTeX file has too many locations");
  }
  if (!finished || unit <= 0 || magnification <= 0 || !sources.size)
    throw new Error("SyncTeX has no usable source locations");
  // Prefer a span containing text over a kern left behind when TeX switches
  // input files before flushing the previous paragraph.
  for (const [path, locations] of sources)
    sources.set(path, [...(textSources.get(path) ?? []), ...locations]);
  return { pages, sources };
}

export function sourceToPdf(index: SyncTexIndex, path: string, line: number) {
  let best: SyncTexLocation | null = null;
  for (const location of index.sources.get(path) ?? []) {
    if (!best || Math.abs(location.line - line) < Math.abs(best.line - line))
      best = location;
  }
  return best;
}

export function pdfToSource(
  index: SyncTexIndex,
  page: number,
  x: number,
  y: number,
) {
  let best: SyncTexLocation | null = null;
  let distance = Infinity;
  for (const location of index.pages.get(page) ?? []) {
    const dx = Math.max(location.x - x, 0, x - location.x - location.width);
    const dy = Math.max(location.y - y, 0, y - location.y - location.height);
    const next = dx * dx + dy * dy;
    if (
      next < distance ||
      (next === distance && best && location.width < best.width)
    ) {
      best = location;
      distance = next;
    }
  }
  return distance <= 24 * 24 ? best : null;
}

// Normalized coordinates in the unrotated PDF page, then in its rendered view.
export function rotatePdfPoint(x: number, y: number, rotation: number) {
  switch (((rotation % 360) + 360) % 360) {
    case 90:
      return { x: 1 - y, y: x };
    case 180:
      return { x: 1 - x, y: 1 - y };
    case 270:
      return { x: y, y: 1 - x };
    default:
      return { x, y };
  }
}
import { type BuildSnapshot } from "@texfolia/contracts";
