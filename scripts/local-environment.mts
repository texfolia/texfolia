export function assertLocalUrl(value: string | undefined, name: string) {
  let url: URL;
  try {
    url = new URL(value ?? "");
  } catch {
    throw new Error(`${name} must be a loopback URL for local development.`);
  }
  const hosts = [
    url.hostname,
    ...url.searchParams.getAll("host"),
    ...url.searchParams.getAll("hostaddr"),
  ];
  if (hosts.some((host) => !["localhost", "127.0.0.1", "[::1]"].includes(host)))
    throw new Error(`${name} must be a loopback URL for local development.`);
}

export function assertLocalEnvironment(
  env: Record<string, string | undefined>,
) {
  for (const name of [
    "CLOUDFLARE_ENV",
    "CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH",
  ]) {
    if (env[name])
      throw new Error(
        `Unset ${name} for local development. Cloud configuration is only for production builds and deploys.`,
      );
  }
  for (const name of [
    "DATABASE_URL",
    "CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE",
    "COMPILER_URL",
    "ENGINE_URL",
  ]) {
    if (env[name] !== undefined) assertLocalUrl(env[name], name);
  }
}
