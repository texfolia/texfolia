import { github } from "./github";
import { gitlab } from "./gitlab";

export type { GitProviderAdapter } from "./types";

/** Registered Git platforms, in display order. */
export const gitProviders = [github, gitlab] as const;
export type GitProvider = (typeof gitProviders)[number]["id"];
export const gitProviderIds = gitProviders.map((p) => p.id) as [
  GitProvider,
  ...GitProvider[],
];

export function isGitProvider(id: string): id is GitProvider {
  return gitProviders.some((p) => p.id === id);
}

export function gitProvider(id: GitProvider) {
  const adapter = gitProviders.find((p) => p.id === id);
  if (!adapter) throw new Error(`Unknown Git provider: ${id}`);
  return adapter;
}

export function gitProviderForHost(host: string) {
  return gitProviders.find((p) => p.host === host) ?? null;
}

/** Whether an account's granted OAuth scopes include repository access. */
export function hasRepositoryAccess(
  provider: GitProvider,
  scope: string | null | undefined,
) {
  const granted = scope?.split(/[ ,]+/) ?? [];
  return gitProvider(provider).scopes.every((s) => granted.includes(s));
}

export const gitHostsLabel = gitProviders.map((p) => p.host).join(" or ");
