import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useState } from "react";

import { Footer } from "#/components/footer";
import { Header } from "#/components/header";
import { Button } from "#/components/ui/button";
import { Checkbox } from "#/components/ui/checkbox";
import { Input } from "#/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "#/components/ui/native-select";
import { Textarea } from "#/components/ui/textarea";
import { getSession } from "#/lib/auth.functions";
import { getProjects } from "#/lib/project.functions";
import { listMyTemplates, publishTemplate } from "#/lib/template.functions";
import {
  publishTemplateSchema,
  templateLicenseLabels,
  templateLicenses,
} from "#/lib/template.schema";

export const Route = createFileRoute("/templates_/publish")({
  beforeLoad: async () => {
    if (!(await getSession()))
      throw redirect({
        to: "/login",
        search: { redirectTo: "/templates/publish" },
      });
  },
  loader: async () => {
    const [projects, templates] = await Promise.all([
      // A select can only list so much; offer the most recent page.
      getProjects({ data: { limit: 200 } }),
      listMyTemplates(),
    ]);
    return { projects: projects.projects, templates };
  },
  head: () => ({
    meta: [
      { title: "Publish a template | Texfolia" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: PublishTemplatePage,
});

function PublishTemplatePage() {
  const { projects, templates } = Route.useLoaderData();
  const navigate = Route.useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <div className="flex min-h-svh flex-col">
      <Header />
      <main id="main-content" className="mx-auto max-w-2xl px-6 py-12 sm:py-16">
        <Link
          to="/templates"
          search={{ page: 0 }}
          className="text-sm underline"
        >
          All templates
        </Link>
        <h1 className="mt-6 font-serif text-4xl tracking-tight sm:text-5xl">
          Publish a template
        </h1>
        <p className="text-muted-foreground mt-4">
          Share an immutable copy of your saved project. Save every file first:
          unsaved browser drafts are not included. Changes to your project won’t
          update this snapshot.
        </p>
        {!projects.length ? (
          <p className="mt-8">
            Create and save a project before publishing.{" "}
            <Link to="/projects" className="underline">
              Go to projects
            </Link>
          </p>
        ) : (
          <form
            className="mt-8 space-y-6"
            onSubmit={async (event) => {
              event.preventDefault();
              setError("");
              const fields = new FormData(event.currentTarget);
              const data = publishTemplateSchema.safeParse({
                projectId: fields.get("projectId"),
                title: fields.get("title"),
                description: fields.get("description"),
                mainFile: fields.get("mainFile"),
                tags: String(fields.get("tags") || "")
                  .split(",")
                  .map((tag) => tag.trim())
                  .filter(Boolean),
                license: fields.get("license"),
                visibility: fields.get("visibility"),
                redistributionConfirmed: fields.get("rights") === "on",
              });
              if (!data.success) {
                setError(
                  data.error.issues.map((issue) => issue.message).join(" "),
                );
                return;
              }
              setBusy(true);
              try {
                const result = await publishTemplate({ data: data.data });
                await navigate({
                  to: "/template/$templateId",
                  params: { templateId: result.id },
                });
              } catch (failure) {
                setError(
                  failure instanceof Error
                    ? failure.message
                    : "Publishing failed. Please try again.",
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            <fieldset disabled={busy} className="space-y-6">
              <label className="block space-y-2">
                <span className="text-sm font-medium">Saved project</span>
                <NativeSelect name="projectId" required className="w-full">
                  {projects.map((project) => (
                    <NativeSelectOption key={project.id} value={project.id}>
                      {project.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </label>
              <label className="block space-y-2">
                <span className="text-sm font-medium">Template title</span>
                <Input name="title" required maxLength={120} />
              </label>
              <label className="block space-y-2">
                <span className="text-sm font-medium">Description</span>
                <Textarea
                  name="description"
                  required
                  maxLength={4000}
                  className="min-h-32"
                />
              </label>
              <label className="block space-y-2">
                <span className="text-sm font-medium">
                  Main LaTeX file (path from project root)
                </span>
                <Input
                  name="mainFile"
                  required
                  defaultValue="main.tex"
                  maxLength={240}
                />
              </label>
              <label className="block space-y-2">
                <span className="text-sm font-medium">
                  Tags, separated by commas (up to 8)
                </span>
                <Input
                  name="tags"
                  placeholder="thesis, journal, article"
                  maxLength={264}
                />
              </label>
              <label className="block space-y-2">
                <span className="text-sm font-medium">License</span>
                <NativeSelect
                  name="license"
                  required
                  defaultValue=""
                  className="w-full"
                >
                  <NativeSelectOption value="" disabled>
                    Choose a license you have the right to grant
                  </NativeSelectOption>
                  {templateLicenses.map((license) => (
                    <NativeSelectOption key={license} value={license}>
                      {templateLicenseLabels[license]}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </label>
              <label className="block space-y-2">
                <span className="text-sm font-medium">Visibility</span>
                <NativeSelect name="visibility" className="w-full">
                  <NativeSelectOption value="public">
                    Public — shown in the gallery after review
                  </NativeSelectOption>
                  <NativeSelectOption value="unlisted">
                    Unlisted — only accessible with the URL after review
                  </NativeSelectOption>
                </NativeSelect>
              </label>
              <label className="flex items-start gap-3 text-sm">
                <Checkbox
                  name="rights"

                  required
                />
                <span>
                  I have the right to redistribute every included file under the
                  selected license. I have included required attribution and
                  license notices. University and journal templates may restrict
                  redistribution.
                </span>
              </label>
              <p className="text-muted-foreground text-sm">
                A first-page preview is generated by the compiler. Each snapshot
                is reviewed before it can be opened. Limit: 3 snapshots per hour
                and 10 per day.
              </p>
              {error && (
                <p role="alert" className="text-destructive">
                  {error}
                </p>
              )}
              <Button disabled={busy}>
                {busy ? "Saving snapshot…" : "Publish snapshot"}
              </Button>
            </fieldset>
          </form>
        )}
        {templates.length > 0 && (
          <section className="mt-16 border-t pt-8">
            <h2 className="text-2xl font-medium">Your snapshots</h2>
            <ul className="mt-4 divide-y">
              {templates.map((template) => (
                <li
                  key={template.id}
                  className="flex flex-wrap items-center justify-between gap-3 py-4"
                >
                  <Link
                    to="/template/$templateId"
                    params={{ templateId: template.id }}
                    className="underline underline-offset-4"
                  >
                    {template.title}
                  </Link>
                  <span className="text-muted-foreground text-sm">
                    {template.status} · {template.visibility}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
      <Footer />
    </div>
  );
}
