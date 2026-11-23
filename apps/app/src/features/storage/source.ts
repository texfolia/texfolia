import { z } from "zod";

export const maxSourceFileBytes = 10 * 1024 * 1024;
export const maxSourceProjectBytes = 50 * 1024 * 1024;
export const sourceContentSchema = z
  .string()
  .max(4 * Math.ceil(maxSourceFileBytes / 3))
  .regex(/^[A-Za-z0-9+/]*={0,2}$/)
  .refine((value) => value.length % 4 === 0, "Invalid base64 content");

export type SourceFiles = Record<string, string | { base64: string }>;

export function sourceFileKind(file: {
  name: string;
  type: string;
}): "text" | "binary" {
  return /\.(tex|ltx|latex|bib|sty|cls|clo|bst|bbx|cbx|lbx|cfg|def|json|yaml|yml|toml|ini|csv|tsv|md|markdown|txt|svg|xml|lua|py|r|jl|sh|js|ts|css|html)$/i.test(
    file.name,
  ) || file.type.startsWith("text/")
    ? "text"
    : "binary";
}

export function encodeSource(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

export function decodeSource(base64: string) {
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

export const saveSourceSchema = z.object({
  projectId: z.uuid(),
  nodeId: z.uuid(),
  expectedObjectKey: z.string().nullable(),
  content: sourceContentSchema,
});
