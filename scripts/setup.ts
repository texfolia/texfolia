import { randomBytes } from "node:crypto";
// First-run setup: create missing local env files, then start Postgres and
// apply the schema. Safe to run again; it never overwrites an existing file.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);

for (const dir of ["apps/app", "apps/web", "packages/db"]) {
  const target = new URL(`${dir}/.env`, root);
  if (existsSync(target)) {
    console.log(`kept    ${dir}/.env`);
    continue;
  }
  const example = readFileSync(new URL(`${dir}/.env.example`, root), "utf8");
  writeFileSync(
    target,
    example.replace(
      /^BETTER_AUTH_SECRET=$/m,
      `BETTER_AUTH_SECRET=${randomBytes(32).toString("base64")}`,
    ),
  );
  console.log(`created ${dir}/.env`);
}

for (const script of ["db:start", "db:push"]) {
  const { exitCode } = Bun.spawnSync(["bun", "run", script], {
    cwd: root.pathname,
    stdio: ["inherit", "inherit", "inherit"],
  });
  if (exitCode !== 0) process.exit(exitCode ?? 1);
}

console.log(`
Setup complete. Fill in the Stripe and Turnstile values in apps/app/.env
(see apps/docs/src/content/docs/local-development.md), then run:

  bun run dev
`);
