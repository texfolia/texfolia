import { z } from "zod";

export const gitProviderSchema = z.enum(["github", "gitlab"]);
export type GitProvider = z.infer<typeof gitProviderSchema>;
export const gitScopes = {
  github: ["repo"],
  gitlab: ["read_repository", "write_repository"],
} satisfies Record<GitProvider, string[]>;
export const gitRemoteSchema = z
  .string()
  .url()
  .transform((value, ctx) => {
    const url = new URL(value);
    const provider: GitProvider | null =
      url.hostname === "github.com"
        ? "github"
        : url.hostname === "gitlab.com"
          ? "gitlab"
          : null;
    const path = url.pathname.replace(/\.git\/?$/, "").replace(/\/$/, "");
    if (
      !provider ||
      url.protocol !== "https:" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/[\w.-]+(?:\/[\w.-]+)+$/.test(path) ||
      path.split("/").some((p) => p === "." || p === "..") ||
      (provider === "github" && path.split("/").length !== 3)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Enter an HTTPS repository URL on github.com or gitlab.com.",
      });
      return z.NEVER;
    }
    return { provider, url: `https://${url.hostname}${path}.git` };
  });
export const gitBranchSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(
    (name) =>
      !name.startsWith("-") &&
      !name.startsWith("/") &&
      !name.endsWith("/") &&
      !name.endsWith(".") &&
      !name.includes("..") &&
      !name.includes("@{") &&
      name !== "@" &&
      // oxlint-disable-next-line no-control-regex -- Git ref names exclude control characters.
      !/[\s~^:?*[\\\u0000-\u001f\u007f]/.test(name) &&
      name
        .split("/")
        .every(
          (part) => part && !part.startsWith(".") && !part.endsWith(".lock"),
        ),
    "Enter a valid git branch name.",
  );
export const gitActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("status") }),
  z.object({ kind: z.literal("diff") }),
  z.object({ kind: z.literal("fetch") }),
  z.object({ kind: z.literal("link"), remote: gitRemoteSchema }),
  z.object({ kind: z.literal("import"), remote: gitRemoteSchema }),
  z.object({ kind: z.literal("unlink") }),
  z.object({
    kind: z.literal("commit"),
    message: z.string().trim().min(1, "Write a commit message.").max(5000),
  }),
  z.object({ kind: z.literal("push") }),
  z.object({ kind: z.literal("pull") }),
  z.object({ kind: z.literal("branch"), name: gitBranchSchema }),
  z.object({ kind: z.literal("checkout"), name: gitBranchSchema }),
]);
export type GitAction = z.infer<typeof gitActionSchema>;
export type GitStatus = {
  remote: { provider: GitProvider; url: string } | null;
  branch: string | null;
  branches: string[];
  changes: { path: string; status: "added" | "modified" | "deleted" }[];
  commits: {
    oid: string;
    message: string;
    author: string;
    timestamp: number;
  }[];
};
export type GitResult = { status: GitStatus; diff?: string };
