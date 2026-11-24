// @ts-check
import react from "@astrojs/react";
import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

// https://astro.build/config
export default defineConfig({
  integrations: [
    starlight({
      title: "Texfolia Docs",
      favicon: "/favicon.svg",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/natebabyak/texfolia",
        },
      ],
      sidebar: [
        {
          label: "Getting Started",
          items: [{ slug: "local-development" }, { slug: "ci" }],
        },
        {
          label: "Workspace & Product",
          items: [
            { slug: "editor-workspace" },
            { slug: "projects" },
            { slug: "project-controls" },
            { slug: "settings" },
            { slug: "themes" },
            { slug: "templates" },
            { slug: "git-integration" },
            { slug: "ai-assistant" },
            { slug: "billing" },
          ],
        },
        {
          label: "Architecture & Operations",
          items: [
            { slug: "source-paths" },
            { slug: "compile-engines" },
            { slug: "compile-telemetry" },
            { slug: "database-deployment" },
            { slug: "auth-abuse-protection" },
            { slug: "security-headers" },
          ],
        },
        {
          label: "Audits",
          items: [{ autogenerate: { directory: "audits" } }],
        },
        {
          label: "Release",
          items: [{ autogenerate: { directory: "release" } }],
        },
      ],
    }),
    react(),
  ],
});
