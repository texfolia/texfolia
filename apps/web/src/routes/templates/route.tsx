import { createFileRoute, Link } from "@tanstack/react-router";
import { z } from "zod";

import { Footer } from "#/components/footer";
import { Header } from "#/components/header";
import { buttonVariants } from "#/components/ui/button";
import { useTemplatePreviews } from "#/lib/template-preview";
import { listTemplates } from "#/lib/template.functions";

export const Route = createFileRoute("/templates")({
  validateSearch: z.object({
    page: z.coerce.number().int().min(0).max(1000).catch(0),
  }),
  loaderDeps: ({ search }) => ({ page: search.page }),
  loader: ({ deps }) => listTemplates({ data: deps }),
  head: () => ({
    meta: [
      { title: "LaTeX templates | Texfolia" },
      {
        name: "description",
        content:
          "Start with a reusable LaTeX template. Open an independent copy in Texfolia and make it yours.",
      },
    ],
  }),
  component: TemplatesPage,
});

function TemplatesPage() {
  const templates = Route.useLoaderData();
  useTemplatePreviews(templates);
  const { page } = Route.useSearch();
  return (
    <div className="flex min-h-svh flex-col">
      <Header />
      <main id="main-content" className="mx-auto max-w-6xl px-6 py-16">
        <div className="mb-12 flex flex-wrap items-end justify-between gap-6">
          <div>
            <h1 className="max-w-2xl font-serif text-5xl leading-tight tracking-tight sm:text-6xl">
              A starting point for your next paper.
            </h1>
            <p className="text-muted-foreground mt-4 max-w-xl text-lg">
              LaTeX templates you can make your own. Every template opens as an
              independent project, with its source files included.
            </p>
          </div>
          <Link
            to="/templates/publish"
            className={buttonVariants({ variant: "outline" })}
          >
            Publish a template
          </Link>
        </div>
        {templates.length ? (
          <div className="grid gap-x-8 gap-y-12 sm:grid-cols-2 lg:grid-cols-3">
            {templates.map((item) => (
              <article key={item.id}>
                <Link
                  to="/template/$templateId"
                  params={{ templateId: item.id }}
                  className="group block rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4"
                >
                  <div className="bg-muted overflow-hidden rounded-lg border">
                    {item.previewStatus === "ready" ? (
                      <img
                        src={`/api/templates/${item.id}/preview`}
                        alt={`First page of ${item.title}`}
                        loading="lazy"
                        width="600"
                        height="780"
                        className="aspect-[10/13] w-full object-cover object-top transition-transform duration-200 motion-safe:group-hover:scale-[1.02]"
                      />
                    ) : (
                      <p className="flex aspect-[10/13] items-center justify-center text-sm">
                        {item.previewStatus === "failed"
                          ? "Preview unavailable"
                          : "Generating preview…"}
                      </p>
                    )}
                  </div>
                  <h2 className="mt-4 text-xl font-medium group-hover:underline">
                    {item.title}
                  </h2>
                </Link>
                <p className="text-muted-foreground mt-1 text-sm">
                  By {item.publisherName} · {item.license}
                </p>
                <p className="mt-3 line-clamp-3 text-sm">{item.description}</p>
                <ul
                  aria-label="Tags"
                  className="text-muted-foreground mt-3 flex flex-wrap gap-2 text-xs"
                >
                  {item.tags.map((tag) => (
                    <li key={tag} className="bg-muted rounded px-2 py-1">
                      {tag}
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        ) : (
          <section className="border-y py-16">
            <h2 className="text-2xl font-medium">
              {page ? "No more templates" : "The library is taking shape"}
            </h2>
            <p className="text-muted-foreground mt-3">
              {page
                ? "Return to the previous page to keep browsing."
                : "Be among the first to share a template. Each snapshot is reviewed before it appears here."}
            </p>
          </section>
        )}
        <nav aria-label="Template pages" className="mt-12 flex gap-4">
          {page > 0 && (
            <Link
              to="/templates"
              search={{ page: page - 1 }}
              className={buttonVariants({ variant: "outline" })}
            >
              Previous
            </Link>
          )}
          {templates.length === 24 && (
            <Link
              to="/templates"
              search={{ page: page + 1 }}
              className={buttonVariants({ variant: "outline" })}
            >
              Next
            </Link>
          )}
        </nav>
      </main>
      <Footer />
    </div>
  );
}
