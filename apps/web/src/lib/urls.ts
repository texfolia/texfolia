import { localHosts, productionHosts } from "@texfolia/auth/hosts";

/** Product app origin for CTAs and the public templates API. */
export function appUrl() {
  const fromEnv = import.meta.env.PUBLIC_APP_URL?.replace(/\/$/, "");
  if (fromEnv) return fromEnv;
  return import.meta.env.PROD ? productionHosts.app : localHosts.app;
}

export function appPath(path: string) {
  return new URL(path, `${appUrl()}/`).href;
}
