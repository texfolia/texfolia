import { expect, test } from "bun:test";

import {
  gitProviderForHost,
  gitProviders,
  hasRepositoryAccess,
  isGitProvider,
} from "../src/providers";
import { gitRemoteSchema } from "../src/schema";

test("every adapter is reachable by its host and id", () => {
  for (const adapter of gitProviders) {
    expect(gitProviderForHost(adapter.host)).toBe(adapter);
    expect(isGitProvider(adapter.id)).toBe(true);
    expect(gitRemoteSchema.parse(adapter.exampleUrl).provider).toBe(adapter.id);
  }
  expect(isGitProvider("google")).toBe(false);
});

test("repository access needs every adapter scope", () => {
  expect(hasRepositoryAccess("github", "read:user,repo")).toBe(true);
  expect(hasRepositoryAccess("github", "read:user")).toBe(false);
  expect(
    hasRepositoryAccess("gitlab", "read_user read_repository write_repository"),
  ).toBe(true);
  expect(hasRepositoryAccess("gitlab", "read_repository")).toBe(false);
  expect(hasRepositoryAccess("gitlab", null)).toBe(false);
});
