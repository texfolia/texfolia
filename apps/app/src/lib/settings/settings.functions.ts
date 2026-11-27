import {
  addPersonalWord,
  defaultSettings,
  settingsSchema,
  type Settings,
} from "./settings.schema";

export type StorageApi = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type StorageEventApi = {
  addEventListener(
    type: "storage",
    listener: (event: StorageEvent) => void,
  ): void;
  removeEventListener(
    type: "storage",
    listener: (event: StorageEvent) => void,
  ): void;
};

export const userSettingsStorageKey = (userId: string) =>
  `texfolia.settings.v2:${userId}`;

const loadErrorMessage =
  "Browser preferences could not be loaded. Editor and shortcut controls are unavailable; reload to try again. Appearance and project settings are still available.";

// Shares same-tab updates between independent stores backed by the same storage.
const storageListeners = new WeakMap<
  StorageApi,
  Map<string, Set<() => void>>
>();

function listenersFor(storage: StorageApi, key: string) {
  let byKey = storageListeners.get(storage);
  if (!byKey) {
    byKey = new Map();
    storageListeners.set(storage, byKey);
  }
  let listeners = byKey.get(key);
  if (!listeners) {
    listeners = new Set();
    byKey.set(key, listeners);
  }
  return listeners;
}

function readSettings(
  storage: StorageApi,
  key: string,
): { value: Settings; loadError: string | null } {
  try {
    const raw = storage.getItem(key);
    if (raw === null) return { value: defaultSettings, loadError: null };
    return {
      value: settingsSchema.parse(JSON.parse(raw)),
      loadError: null,
    };
  } catch {
    return { value: defaultSettings, loadError: loadErrorMessage };
  }
}

export function createSettingsStore({
  storage,
  storageEventApi,
  userId,
}: {
  storage: StorageApi;
  userId: string;
  storageEventApi: StorageEventApi;
}) {
  const key = userSettingsStorageKey(userId);
  const listeners = new Set<() => void>();
  let snapshot = readSettings(storage, key);

  function refresh() {
    snapshot = readSettings(storage, key);
    for (const listener of listeners) listener();
  }

  function onStorageEvent(event: StorageEvent) {
    if (event.key === key || event.key === null) refresh();
  }

  function notifyPeers() {
    for (const notify of listenersFor(storage, key)) notify();
  }

  function write(next: Settings) {
    if (snapshot.loadError) throw new Error(snapshot.loadError);
    const parsed = settingsSchema.parse(next);
    storage.setItem(key, JSON.stringify(parsed));
    snapshot = { value: parsed, loadError: null };
    notifyPeers();
  }

  const peerListeners = listenersFor(storage, key);

  return {
    get: () => snapshot.value,
    getLoadError: () => snapshot.loadError,
    subscribe(listener: () => void) {
      if (listeners.size === 0) {
        peerListeners.add(refresh);
        storageEventApi.addEventListener("storage", onStorageEvent);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          peerListeners.delete(refresh);
          storageEventApi.removeEventListener("storage", onStorageEvent);
        }
      };
    },
    updateEditor(editor: Settings["editor"]) {
      write({ ...snapshot.value, editor });
    },
    /** Adds a word to the personal dictionary immediately. */
    addWord(word: string) {
      write({
        ...snapshot.value,
        spelling: {
          words: addPersonalWord(snapshot.value.spelling.words, word),
        },
      });
    },
    save(settings: Settings) {
      write(settings);
    },
  };
}

export function createBrowserSettingsStore(
  browser: StorageEventApi & { readonly localStorage: StorageApi },
  userId: string,
) {
  let storage: StorageApi;
  let warning: string | null = null;
  try {
    storage = browser.localStorage;
  } catch {
    const values = new Map<string, string>();
    storage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
      removeItem: (key) => {
        values.delete(key);
      },
    };
    warning =
      "Browser storage is unavailable. Preferences apply until you leave this page.";
  }
  return {
    ...createSettingsStore({ storage, storageEventApi: browser, userId }),
    warning,
  };
}
