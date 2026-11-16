import { afterEach, expect, test } from "bun:test";

import type { StorageApi, StorageEventApi } from "@tanstack/react-db";

import {
  createBrowserSettingsStore,
  createSettingsStore,
} from "./settings.functions";
import { settingsSchema } from "./settings.schema";
import { defaultShortcuts } from "./shortcuts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function createStorage() {
  const values = new Map<string, string>();
  let failWrites = false;
  const storage: StorageApi = {
    getItem: (key) => values.get(key) ?? null,
    setItem(key, value) {
      if (failWrites) throw new Error("quota");
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
  const storageEventApi: StorageEventApi = {
    addEventListener() {},
    removeEventListener() {},
  };
  return {
    storage,
    storageEventApi,
    failWrites: () => {
      failWrites = true;
    },
  };
}

function storeFor(backend: ReturnType<typeof createStorage>) {
  const store = createSettingsStore({ ...backend, userId: "test-user" });
  cleanups.push(() => store.preferences.cleanup());
  return store;
}

test("existing editor preferences migrate without local formatting and survive a fresh store", async () => {
  const backend = createStorage();
  backend.storage.setItem(
    "texfolia.editor",
    JSON.stringify({ fontSize: 18, wrapLines: false }),
  );
  backend.storage.setItem(
    "texfolia.format",
    JSON.stringify({ indent: 4, wrap: false, width: 120 }),
  );
  const store = storeFor(backend);
  await store.initialize();
  expect(store.preferences.get("preferences")?.editor).toEqual({
    fontSize: 18,
    wrapLines: false,
  });
  await store.updateEditor({ fontSize: 20, wrapLines: true });
  const fresh = storeFor(backend);
  await fresh.initialize();
  expect(settingsSchema.parse(fresh.preferences.get("preferences"))).toEqual({
    id: "preferences",
    editor: { fontSize: 20, wrapLines: true },
    shortcuts: defaultShortcuts,
  });
});

test("malformed legacy preferences fall back to usable defaults", async () => {
  const backend = createStorage();
  backend.storage.setItem("texfolia.editor", "{broken");
  backend.storage.setItem(
    "texfolia.format",
    JSON.stringify({ indent: -1, wrap: true, width: 12 }),
  );
  const store = storeFor(backend);
  await store.initialize();
  expect(store.preferences.get("preferences")?.editor.fontSize).toBe(13);
  expect(store.preferences.get("preferences")?.shortcuts).toEqual(
    defaultShortcuts,
  );
});

test("active settings consumers see each other's updates", async () => {
  const backend = createStorage();
  const first = storeFor(backend);
  const second = storeFor(backend);
  await first.initialize();
  await second.initialize();
  await first.save({
    id: "preferences",
    editor: { fontSize: 13, wrapLines: true },
    shortcuts: { ...defaultShortcuts, save: "Mod+Shift+S" },
  });
  expect(second.preferences.get("preferences")?.shortcuts.save).toBe(
    "Mod+Shift+S",
  );
  await second.updateEditor({
    fontSize: 22,
    wrapLines: false,
  });
  expect(first.preferences.get("preferences")?.editor.fontSize).toBe(22);
  expect(first.preferences.get("preferences")?.shortcuts.save).toBe(
    "Mod+Shift+S",
  );
});

test("storage failure rejects the change and rolls preferences back", async () => {
  const backend = createStorage();
  const store = storeFor(backend);
  await store.initialize();
  backend.failWrites();
  await expect(
    store.updateEditor({ fontSize: 23, wrapLines: false }),
  ).rejects.toThrow();
  expect(store.preferences.get("preferences")?.editor.fontSize).toBe(13);
});

test("denied browser storage still allows session preferences", async () => {
  const store = createBrowserSettingsStore(
    {
      get localStorage(): StorageApi {
        throw new Error("denied");
      },
      addEventListener() {},
      removeEventListener() {},
    },
    "test-user",
  );
  cleanups.push(() => store.preferences.cleanup());
  await store.initialize();
  await store.updateEditor({ fontSize: 19, wrapLines: false });
  expect(store.preferences.get("preferences")?.editor.fontSize).toBe(19);
  expect(store.warning).toContain("until you leave this page");
});

test("corrupt current preferences are reported without overwriting saved data", async () => {
  const backend = createStorage();
  backend.storage.setItem("texfolia.settings.v2:test-user", "{broken");
  const store = storeFor(backend);
  await expect(store.initialize()).rejects.toThrow();
  expect(backend.storage.getItem("texfolia.settings.v2:test-user")).toBe(
    "{broken",
  );
});

test("user preferences and shortcuts are isolated by account", async () => {
  const backend = createStorage();
  const first = storeFor(backend);
  const second = createSettingsStore({ ...backend, userId: "another-user" });
  cleanups.push(() => second.preferences.cleanup());
  await first.initialize();
  await second.initialize();
  await first.save({
    id: "preferences",
    editor: { fontSize: 24, wrapLines: false },
    shortcuts: { ...defaultShortcuts, newProject: "G P" },
  });
  expect(second.preferences.get("preferences")?.editor.fontSize).toBe(13);
  expect(second.preferences.get("preferences")?.shortcuts.newProject).toBe(
    "N P",
  );
  const reopened = storeFor(backend);
  await reopened.initialize();
  expect(reopened.preferences.get("preferences")?.shortcuts.newProject).toBe(
    "G P",
  );
});

test("v1 collection editor values migrate without copying browser formatting", async () => {
  const backend = createStorage();
  backend.storage.setItem(
    "texfolia.settings.v1",
    JSON.stringify({
      "s:preferences": {
        versionKey: "legacy",
        data: {
          id: "preferences",
          editor: { fontSize: 21, wrapLines: false },
          formatting: { indent: 8, wrap: false, width: 150 },
        },
      },
    }),
  );
  const store = storeFor(backend);
  await store.initialize();
  expect(store.preferences.get("preferences")?.editor).toEqual({
    fontSize: 21,
    wrapLines: false,
  });
  expect(
    Object.hasOwn(store.preferences.get("preferences") ?? {}, "formatting"),
  ).toBe(false);
});
