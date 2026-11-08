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
  formatSettingsSchema,
  settingsSchema,
} from "./settings.schema";

const storageKey = "texfolia.settings.v1";
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

export function createSettingsStore({
  storage,
  storageEventApi,
}: {
  storage: StorageApi;
  storageEventApi: StorageEventApi;
}) {
  const preferences = createCollection(
    localStorageCollectionOptions({
      storageKey,
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
          editor: readLegacy(
            storage,
            "texfolia.editor",
            editorSettingsSchema,
            defaultSettings.editor,
          ),
          formatting: readLegacy(
            storage,
            "texfolia.format",
            formatSettingsSchema,
            defaultSettings.formatting,
          ),
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
    async updateFormatting(formatting: typeof defaultSettings.formatting) {
      await preferences
        .update("preferences", (draft) => {
          draft.formatting = formatting;
        })
        .when("settled");
    },
  };
}

export function createBrowserSettingsStore(
  browser: StorageEventApi & { readonly localStorage: StorageApi },
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
    ...createSettingsStore({ storage, storageEventApi: browser }),
    warning,
  };
}
