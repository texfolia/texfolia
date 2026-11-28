interface Fetcher {
  fetch: typeof fetch;
}

type SendEmail = import("@cloudflare/workers-types/index").SendEmail;

declare module "cloudflare:workers" {
  export const env: Cloudflare.Env;
}
