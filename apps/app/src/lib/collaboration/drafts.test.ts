import { expect, test } from "bun:test";

import { decodeSource, encodeSource, sourceContentSchema } from "#/lib/storage";

import { reconcileSourceDrafts, serializeSourceDrafts } from "./drafts";

test("legacy browser drafts migrate only when there is no server content", () => {
  const result = reconcileSourceDrafts({
    raw: JSON.stringify({
      unsaved: "local work",
      saved: "old browser copy",
      deleted: "removed file",
    }),
    contents: { unsaved: "", saved: "server work" },
    versions: {
      unsaved: { objectKey: null, updatedAt: 100 },
      saved: { objectKey: "server-key", updatedAt: 200 },
    },
  });
  expect(Object.keys(result.migrate)).toEqual(["unsaved"]);
  expect(result.recover.saved?.value).toBe("old browser copy");
  expect(result.recover.deleted).toBeUndefined();
});

test("newer local drafts are offered for recovery without replacing server contents", () => {
  const contents = { main: "saved on another device" };
  const result = reconcileSourceDrafts({
    raw: serializeSourceDrafts({
      main: { value: "offline edit", updatedAt: 300, baseObjectKey: "old-key" },
    }),
    contents,
    versions: { main: { objectKey: "new-key", updatedAt: 200 } },
  });
  expect(result.migrate).toEqual({});
  expect(result.recover.main?.value).toBe("offline edit");
  expect(contents.main).toBe("saved on another device");
});

test("older conflicting drafts are preserved when clocks disagree, identical drafts are removed", () => {
  const result = reconcileSourceDrafts({
    raw: serializeSourceDrafts({
      different: { value: "keep me", updatedAt: 1, baseObjectKey: null },
      same: { value: "already saved", updatedAt: 1, baseObjectKey: null },
    }),
    contents: { different: "server", same: "already saved" },
    versions: {
      different: { objectKey: "key", updatedAt: 1000 },
      same: { objectKey: "key", updatedAt: 1000 },
    },
  });
  expect(Object.keys(result.recover)).toEqual(["different"]);
});

test("a fresh browser loads no competing drafts and corrupt caches are not treated as empty", () => {
  expect(
    reconcileSourceDrafts({ raw: null, contents: {}, versions: {} }),
  ).toEqual({ migrate: {}, recover: {} });
  expect(() =>
    reconcileSourceDrafts({ raw: "broken", contents: {}, versions: {} }),
  ).toThrow();
});

test("source encoding preserves UTF-8 and arbitrary binary bytes", () => {
  const bytes = new Uint8Array([0, 1, 127, 128, 255]);
  expect(encodeSource(bytes)).toBe("AAF/gP8=");
  expect(decodeSource(sourceContentSchema.parse("AAF/gP8="))).toEqual(bytes);
  const unicode = new TextEncoder().encode("é 🦉 LaTeX");
  expect(new TextDecoder().decode(decodeSource(encodeSource(unicode)))).toBe(
    "é 🦉 LaTeX",
  );
  for (const invalid of ["a", "====", "a===", "a a=", "!!!!"])
    expect(sourceContentSchema.safeParse(invalid).success).toBe(false);
});
