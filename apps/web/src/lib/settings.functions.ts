import {
  createCollection,
  localStorageCollectionOptions,
  type StorageApi,
  type StorageEventApi,
} from "@tanstack/react-db";
import { z } from "zod";

import {
  defaultSettings,
  editorSettingsSchema,
  settingsSchema,
} from "./settings.schema";

export const userSettingsStorageKey = (userId: string) =>
  `texfolia.settings.v2:${userId}`;
const storedSettingsSchema = z.record(
  z.string(),
  z.object({
    versionKey: z.string(),
    data: settingsSchema,
  }),
);

function readLegacy<T>(
  storage: StorageApi,
  key: string,
  schema: z.ZodType<T>,
  fallback: T,
): T {
  try {
    const result = schema.safeParse(JSON.parse(storage.getItem(key) ?? "null"));
    return result.success ? result.data : fallback;
  } catch {
    return fallback;
  }
}

function readLegacyEditor(storage: StorageApi) {
  const legacy = readLegacy(
    storage,
    "texfolia.settings.v1",
    z.record(
      z.string(),
      z.object({ data: z.object({ editor: editorSettingsSchema }) }),
    ),
    {},
  );
  return (
    (legacy["s:preferences"] ?? legacy.preferences)?.data.editor ??
    readLegacy(
      storage,
      "texfolia.editor",
      editorSettingsSchema,
      defaultSettings.editor,
    )
  );
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
  const preferences = createCollection(
    localStorageCollectionOptions({
      storageKey: userSettingsStorageKey(userId),
      storage,
      storageEventApi,
      schema: settingsSchema,
      getKey: (row) => row.id,
      gcTime: Infinity,
      parser: {
        parse: (text) => storedSettingsSchema.parse(JSON.parse(text)),
        stringify: JSON.stringify,
      },
    }),
  );

  async function initialize() {
    await preferences.preload();
    if (!preferences.has("preferences")) {
      await preferences
        .insert({
          ...defaultSettings,
          editor: readLegacyEditor(storage),
        })
        .when("settled");
    }
  }

  return {
    preferences,
    initialize,
    async updateEditor(editor: typeof defaultSettings.editor) {
      await preferences
        .update("preferences", (draft) => {
          draft.editor = editor;
        })
        .when("settled");
    },
    async save(settings: typeof defaultSettings) {
      const next = settingsSchema.parse(settings);
      await preferences
        .update("preferences", (draft) => {
          draft.editor = next.editor;
          draft.compile = next.compile;
          draft.shortcuts = next.shortcuts;
        })
        .when("settled");
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
