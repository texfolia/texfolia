import { z } from "zod";

const draftSchema = z.object({
  value: z.string(),
  updatedAt: z.number().finite(),
  baseObjectKey: z.string().nullable(),
});
export type SourceDraft = z.infer<typeof draftSchema>;
const cacheSchema = z.object({
  version: z.literal(1),
  drafts: z.record(z.string(), draftSchema),
});
const legacySchema = z.record(z.string(), z.string());

export function reconcileSourceDrafts({
  raw,
  contents,
  versions,
}: {
  raw: string | null;
  contents: Record<string, string>;
  versions: Record<string, { objectKey: string | null; updatedAt: number }>;
}) {
  const migrate: Record<string, SourceDraft> = {};
  const recover: Record<string, SourceDraft> = {};
  if (!raw) return { migrate, recover };
  const parsed: unknown = JSON.parse(raw);
  const cache = cacheSchema.safeParse(parsed);
  const legacy = cache.success ? null : legacySchema.parse(parsed);
  const entries = cache.success
    ? cache.data.drafts
    : Object.fromEntries(
        Object.entries(legacy ?? {}).map(([id, value]) => [
          id,
          { value, updatedAt: 0, baseObjectKey: null },
        ]),
      );
  for (const [id, draft] of Object.entries(entries)) {
    if (!Object.hasOwn(contents, id) || draft.value === contents[id]) continue;
    if (legacy && versions[id]?.objectKey === null) migrate[id] = draft;
    else recover[id] = draft;
  }
  return { migrate, recover };
}

export function serializeSourceDrafts(drafts: Record<string, SourceDraft>) {
  return JSON.stringify({ version: 1, drafts });
}
