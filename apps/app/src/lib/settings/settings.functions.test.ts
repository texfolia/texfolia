import { afterEach, expect, test } from "bun:test";

import { defaultShortcuts } from "#/lib/shortcuts/shortcuts";

import {
  createBrowserSettingsStore,
  createSettingsStore,
  userSettingsStorageKey,
  type StorageApi,
  type StorageEventApi,
} from "./settings.functions";
import { settingsSchema } from "./settings.schema";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function createStorage() {
  const values = new Map<string, string>();
  const eventListeners = new Set<(event: StorageEvent) => void>();
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
    addEventListener(_type, listener) {
      eventListeners.add(listener);
    },
    removeEventListener(_type, listener) {
      eventListeners.delete(listener);
    },
  };
  return {
    storage,
    storageEventApi,
    emitStorage(key: string | null) {
      for (const listener of eventListeners) listener({ key } as StorageEvent);
    },
    failWrites: () => {
      failWrites = true;
    },
  };
}

function storeFor(
  backend: ReturnType<typeof createStorage>,
  userId = "test-user",
) {
  const store = createSettingsStore({ ...backend, userId });
  cleanups.push(store.subscribe(() => {}));
  return store;
}

test("editor preferences persist and survive a fresh store", () => {
  const backend = createStorage();
  const store = storeFor(backend);
  store.updateEditor({ fontSize: 20, wrapLines: false, keymap: "vim" });
  const fresh = storeFor(backend);
  expect(settingsSchema.parse(fresh.get())).toEqual({
    editor: { fontSize: 20, wrapLines: false, keymap: "vim" },
    compile: { onSave: true, afterIdle: 0 },
    shortcuts: defaultShortcuts,
    spelling: { words: [] },
  });
});

test("active settings consumers see each other's updates in the same tab and across tabs", () => {
  const backend = createStorage();
  const first = storeFor(backend);
  const second = storeFor(backend);
  first.save({
    editor: { fontSize: 13, wrapLines: true, keymap: "default" },
    compile: { onSave: true, afterIdle: 0 },
    shortcuts: { ...defaultShortcuts, save: "Mod+Shift+S" },
    spelling: { words: [] },
  });
  expect(second.get().shortcuts.save).toBe("Mod+Shift+S");
  second.updateEditor({ fontSize: 22, wrapLines: false, keymap: "default" });
  expect(first.get().editor.fontSize).toBe(22);
  expect(first.get().shortcuts.save).toBe("Mod+Shift+S");

  backend.storage.setItem(
    userSettingsStorageKey("test-user"),
    JSON.stringify({
      ...first.get(),
      compile: { onSave: false, afterIdle: 2 },
    }),
  );
  backend.emitStorage(userSettingsStorageKey("test-user"));
  expect(first.get().compile).toEqual({ onSave: false, afterIdle: 2 });
});

test("storage failure rejects the change and keeps previous preferences", () => {
  const backend = createStorage();
  const store = storeFor(backend);
  backend.failWrites();
  expect(() =>
    store.updateEditor({ fontSize: 23, wrapLines: false, keymap: "default" }),
  ).toThrow();
  expect(store.get().editor.fontSize).toBe(13);
});

test("denied browser storage still allows session preferences", () => {
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
  store.updateEditor({ fontSize: 19, wrapLines: false, keymap: "default" });
  expect(store.get().editor.fontSize).toBe(19);
  expect(store.warning).toContain("until you leave this page");
});

test("corrupt current preferences are reported without overwriting saved data", () => {
  const backend = createStorage();
  const key = userSettingsStorageKey("test-user");
  backend.storage.setItem(key, "{broken");
  const store = storeFor(backend);
  expect(store.getLoadError()).toContain("could not be loaded");
  expect(() =>
    store.updateEditor({ fontSize: 18, wrapLines: true, keymap: "default" }),
  ).toThrow();
  expect(backend.storage.getItem(key)).toBe("{broken");
});

test("user preferences and shortcuts are isolated by account", () => {
  const backend = createStorage();
  const first = storeFor(backend, "test-user");
  const second = storeFor(backend, "another-user");
  first.save({
    editor: { fontSize: 24, wrapLines: false, keymap: "default" },
    compile: { onSave: false, afterIdle: 5 },
    shortcuts: { ...defaultShortcuts, newProject: "G P" },
    spelling: { words: [] },
  });
  expect(second.get().editor.fontSize).toBe(13);
  expect(second.get().compile.onSave).toBe(true);
  expect(second.get().shortcuts.newProject).toBe("N P");
  const reopened = storeFor(backend, "test-user");
  expect(reopened.get().compile).toEqual({ onSave: false, afterIdle: 5 });
  expect(reopened.get().shortcuts.newProject).toBe("G P");
});

test("stored preferences missing newer optional fields receive defaults", () => {
  const backend = createStorage();
  const key = userSettingsStorageKey("test-user");
  backend.storage.setItem(
    key,
    JSON.stringify({
      editor: { fontSize: 15, wrapLines: true },
      compile: { onSave: false },
      shortcuts: defaultShortcuts,
    }),
  );
  const store = storeFor(backend);
  expect(store.getLoadError()).toBeNull();
  expect(store.get()).toEqual({
    editor: { fontSize: 15, wrapLines: true, keymap: "default" },
    compile: { onSave: false, afterIdle: 0 },
    shortcuts: defaultShortcuts,
    spelling: { words: [] },
  });
});

test("addWord normalizes, deduplicates, and persists personal dictionary entries", () => {
  const backend = createStorage();
  const store = storeFor(backend);
  store.addWord("Tectonic");
  store.addWord("Tectonic");
  store.addWord("BibLaTeX");
  expect(store.get().spelling.words).toEqual(["BibLaTeX", "Tectonic"]);
  expect(storeFor(backend).get().spelling.words).toEqual([
    "BibLaTeX",
    "Tectonic",
  ]);
});
