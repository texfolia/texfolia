import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Pages with no request-time data are rendered once at build time and served
// as static assets. /templates reads the live catalog from the app per request.
const staticPages = ["/", "/pricing", "/privacy", "/terms"];

export default defineConfig({
  envPrefix: ["PUBLIC_"],
  resolve: { tsconfigPaths: true },
  plugins: [
    devtools(),
    cloudflare({ viteEnvironment: { name: "ssr" }, remoteBindings: false }),
    tailwindcss(),
    tanstackStart({
      prerender: {
        enabled: true,
        crawlLinks: false,
        autoStaticPathsDiscovery: false,
        autoSubfolderIndex: false,
      },
      pages: staticPages.map((path) => ({ path })),
    }),
    viteReact(),
  ],
});
