import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

import { assertLocalEnvironment } from "../../scripts/local-environment.mts";

export default defineConfig(({ command, mode }) => {
  if (command === "serve")
    assertLocalEnvironment({
      ...loadEnv(mode, process.cwd(), ""),
      ...process.env,
    });
  return {
    envPrefix: ["VITE_", "PUBLIC_"],
    resolve: { tsconfigPaths: true },
    plugins: [
      devtools(),
      cloudflare({ viteEnvironment: { name: "ssr" }, remoteBindings: false }),
      tailwindcss(),
      tanstackStart(),
      viteReact(),
    ],
  };
});
