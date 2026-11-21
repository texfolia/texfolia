import { localHosts, productionHosts } from "@texfolia/auth/hosts";

/** Marketing site origin for Templates, Pricing, Privacy, and Terms links. */
export function webOrigin() {
  const fromEnv = import.meta.env.PUBLIC_WEB_URL?.replace(/\/$/, "");
  if (fromEnv) return fromEnv;
  return import.meta.env.PROD ? productionHosts.web[0]! : localHosts.web[0]!;
}

export function webPath(path: string) {
  return new URL(path, `${webOrigin()}/`).href;
}
