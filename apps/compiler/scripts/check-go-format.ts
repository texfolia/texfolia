const result = Bun.spawnSync(["gofmt", "-l", "engine"], {
  stdout: "pipe",
  stderr: "inherit",
});
if (result.exitCode !== 0) process.exit(result.exitCode);
const files = new TextDecoder().decode(result.stdout).trim();
if (files) {
  console.error("Run bun run format to format these Go files:\n" + files);
  process.exit(1);
}
