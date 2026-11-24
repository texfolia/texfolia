import { parse } from "yaml";

/**
 * Project-level agent conventions, read from plain project files so any
 * agent (Texfolia's or one working on a Git clone) sees the same thing:
 *
 * - `AGENTS.md` (https://agents.md) holds project instructions. A nested
 *   `AGENTS.md` applies to its folder.
 * - `.agents/skills/<name>/SKILL.md` follows the Agent Skills format
 *   (https://agentskills.io/specification): YAML frontmatter with a `name`
 *   and `description`, then Markdown instructions. Other files in the skill
 *   folder (scripts, references, assets such as LaTeX snippets) are ordinary
 *   project files.
 */
export const agentsFileName = "AGENTS.md";
export const skillsFolder = ".agents/skills";
const skillPath = /^\.agents\/skills\/([^/]+)\/SKILL\.md$/;

/** Frontmatter limits from the Agent Skills specification. */
const maxNameLength = 64;
const maxDescriptionLength = 1024;
const namePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type SkillSummary = {
  name: string;
  description: string;
  path: string;
  /** Why the file does not follow the specification, when it does not. */
  problems?: string[];
};

export function isAgentsFile(path: string) {
  return path === agentsFileName || path.endsWith(`/${agentsFileName}`);
}

/** The folder name of a skill entry point, or null for any other path. */
export function skillFolderName(path: string) {
  return skillPath.exec(path)?.[1] ?? null;
}

/** Splits a leading `---` YAML block from the Markdown body. */
function frontmatter(source: string) {
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
  return match?.[1];
}

/**
 * Reads a SKILL.md's name and description. Problems are reported rather than
 * thrown, so one malformed skill does not hide the others.
 */
export function parseSkill(path: string, source: string): SkillSummary {
  const folder = skillFolderName(path) ?? "";
  const problems: string[] = [];
  const block = frontmatter(source);
  let data: unknown;
  if (block === undefined) problems.push("Missing YAML frontmatter.");
  else
    try {
      data = parse(block);
    } catch {
      problems.push("Frontmatter is not valid YAML.");
    }
  const fields =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  if (block !== undefined && data !== undefined && fields !== data)
    problems.push("Frontmatter must be a YAML mapping.");

  let name = folder;
  if (typeof fields.name === "string" && fields.name.trim()) {
    name = fields.name.trim();
    if (name.length > maxNameLength || !namePattern.test(name))
      problems.push(
        "name must be 1–64 lowercase letters, digits, and single hyphens.",
      );
    if (name !== folder)
      problems.push(`name must match its folder name (${folder}).`);
  } else problems.push("Missing name.");

  let description = "";
  if (typeof fields.description === "string" && fields.description.trim()) {
    description = fields.description.trim();
    if (description.length > maxDescriptionLength) {
      problems.push("description must be at most 1024 characters.");
      description = `${description.slice(0, maxDescriptionLength)}…`;
    }
  } else problems.push("Missing description.");

  return {
    name,
    description,
    path,
    ...(problems.length ? { problems } : {}),
  };
}
