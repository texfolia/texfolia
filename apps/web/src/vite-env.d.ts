/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Product app origin; defaults to the local or production app host. */
  readonly PUBLIC_APP_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
