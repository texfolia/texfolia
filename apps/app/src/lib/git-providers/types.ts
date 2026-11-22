/**
 * A Git hosting platform Texfolia integrates with. The core Git module
 * (`../git.ts`, `../git.server.ts`, `../git-repository.server.ts`) speaks plain
 * Git smart HTTP; an adapter supplies only what differs per platform.
 *
 * To add a platform: add its Better Auth social provider in `packages/auth`,
 * write an adapter next to this file, and register it in `index.ts`.
 */
export type GitProviderAdapter = {
  /** Better Auth social provider ID. Also stored in `project_git.provider`. */
  id: string;
  label: string;
  /** HTTPS host that serves the platform's repositories. */
  host: string;
  /** OAuth scopes that let Texfolia read and push the user's repositories. */
  scopes: readonly string[];
  /** Username sent with the OAuth token in Git HTTP basic authentication. */
  tokenUsername: string;
  /** Whether URL path segments, without `.git`, name a repository. */
  isRepositoryPath(segments: readonly string[]): boolean;
  /** Placeholder for repository URL fields. */
  exampleUrl: string;
};

export function defineGitProvider<const T extends GitProviderAdapter>(
  adapter: T,
) {
  return adapter;
}
