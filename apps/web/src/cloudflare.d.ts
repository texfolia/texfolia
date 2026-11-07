interface Fetcher {
  fetch: typeof fetch;
}

declare module "cloudflare:workers" {
  export const env: Cloudflare.Env;
}
