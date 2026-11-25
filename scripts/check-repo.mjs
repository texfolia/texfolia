import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import postcss from "postcss";

import { headingIds, withoutFences } from "./markdown-headings.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const docsContentRoot = resolve(root, "apps/docs/src/content/docs");
const files = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  {
    cwd: root,
    encoding: "utf8",
  },
)
  .split("\0")
  .filter(Boolean);
const errors = [];

/** The page that a site path such as `/projects/` shows, if there is one. */
function starlightPage(target) {
  const slug = target.replace(/^\/+|\/+$/g, "");
  const candidates = slug
    ? [
        resolve(docsContentRoot, `${slug}.md`),
        resolve(docsContentRoot, `${slug}.mdx`),
        resolve(docsContentRoot, slug, "index.md"),
        resolve(docsContentRoot, slug, "index.mdx"),
      ]
    : [
        resolve(docsContentRoot, "index.md"),
        resolve(docsContentRoot, "index.mdx"),
      ];
  return candidates.find((candidate) => existsSync(candidate));
}

const fragments = new Map();
function hasFragment(path, fragment) {
  let ids = fragments.get(path);
  if (!ids) {
    ids = headingIds(readFileSync(path, "utf8"));
    fragments.set(path, ids);
  }
  return ids.has(decodeURIComponent(fragment));
}

for (const file of files) {
  const isDocsContent = file.startsWith("apps/docs/src/content/docs/");
  if (
    !(file.endsWith(".md") || (isDocsContent && file.endsWith(".mdx"))) ||
    file.startsWith(".agents/") ||
    !existsSync(resolve(root, file))
  )
    continue;
  const markdown = withoutFences(readFileSync(resolve(root, file), "utf8"));
  for (const match of markdown.matchAll(
    /\[[^\]\n]*\]\(<?([^\s)>]+)>?(?:\s+"[^"]*")?\)/g,
  )) {
    if (/^(?:[a-z][\w+.-]*:|\/\/)/i.test(match[1])) continue;
    const [address, fragment] = match[1].split("#");
    const target = address.split("?")[0];
    const path = !target
      ? resolve(root, file)
      : isDocsContent && target.startsWith("/")
        ? starlightPage(target)
        : target.startsWith("/")
          ? resolve(root, `.${target}`)
          : resolve(root, dirname(file), decodeURIComponent(target));
    if (!path || !existsSync(path))
      errors.push(`${file}: broken local link ${match[1]}`);
    // Other files have fragments of their own, such as a line number.
    else if (fragment && /\.mdx?$/.test(path) && !hasFragment(path, fragment))
      errors.push(`${file}: broken heading link ${match[1]}`);
  }
}

for (const file of files.filter(
  (file) => file.startsWith("apps/app/src/") && file.endsWith(".css"),
)) {
  if (file !== "apps/app/src/styles.css") {
    errors.push(
      `${file}: put styles in Tailwind classes, theme tokens, or @utility in styles.css`,
    );
    continue;
  }
  const css = postcss.parse(readFileSync(resolve(root, file), "utf8"), {
    from: file,
  });
  for (const node of css.nodes) {
    if (node.type === "comment") continue;
    if (
      node.type === "atrule" &&
      [
        "import",
        "source",
        "custom-variant",
        "theme",
        "utility",
        "font-face",
      ].includes(node.name)
    )
      continue;
    if (
      node.type === "rule" &&
      [":root", ".dark"].includes(node.selector) &&
      node.nodes.every(
        (child) =>
          child.type === "comment" ||
          (child.type === "decl" && child.prop.startsWith("--")),
      )
    )
      continue;
    errors.push(
      `${relative(root, node.source.input.file)}:${node.source.start.line}: use Tailwind classes; styles.css allows only imports, theme tokens, font setup, and @utility`,
    );
  }
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.info(
    "Local Markdown links, heading links, and Tailwind-only styles passed.",
  );
}
