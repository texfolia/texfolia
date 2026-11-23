// Standalone typecheck only. Apps resolve `R2Bucket` from their own generated
// Workers types, so this file is not part of the public API.
declare global {
  type R2Bucket = import("@cloudflare/workers-types").R2Bucket;
}

export {};
