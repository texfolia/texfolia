// Standalone typecheck only. Apps resolve these from their own generated
// Workers types and Vite, so this file is not part of the public API.
declare global {
  type R2Bucket = import("@cloudflare/workers-types").R2Bucket;
  // A DOM-typed stand-in: the Workers `Fetcher` uses its own `Response`.
  type Fetcher = {
    fetch(input: URL | RequestInfo, init?: RequestInit): Promise<Response>;
  };
  interface ImportMeta {
    readonly env: { readonly DEV: boolean };
  }
}

export {};
