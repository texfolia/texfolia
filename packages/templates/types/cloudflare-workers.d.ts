// Standalone typecheck only; the app's `wrangler types` output declares the
// real module with every binding.
declare module "cloudflare:workers" {
  export const env: { COMPILER: Fetcher };
}
