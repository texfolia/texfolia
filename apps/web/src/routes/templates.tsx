import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

import { Page } from "#/components/page";
import { pageHead } from "#/lib/head";
import { linkButton } from "#/lib/link-button";
import {
  fetchTemplateCatalog,
  parseTemplatePage,
  type PublicTemplate,
} from "#/lib/templates";
import { appPath, appUrl } from "#/lib/urls";

// Runs on the web Worker, so browsers never call the app's API cross-origin.
const loadTemplates = createServerFn({ method: "GET" })
  .validator((page: unknown) => parseTemplatePage(page))
  .handler(({ data: page }) => fetchTemplateCatalog(appUrl(), page));

export const Route = createFileRoute("/templates")({
  // Always return the key: the router keeps raw search values a validator omits.
  validateSearch: (search: Record<string, unknown>): { page?: number } => ({
    page: parseTemplatePage(search.page) || undefined,
  }),
  loaderDeps: ({ search }) => ({ page: search.page ?? 0 }),
  loader: async ({ deps }) => ({
    page: deps.page,
    catalog: await loadTemplates({ data: deps.page }),
  }),
  head: () =>
    pageHead({
      title: "LaTeX templates | Texfolia",
      description:
        "Start with a reusable LaTeX template. Open an independent copy in Texfolia and make it yours.",
    }),
  component: Templates,
});

function Templates() {
  const { page, catalog } = Route.useLoaderData();
  return (
    <Page>
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
          <a
            href={appPath("/templates/publish")}
            className={linkButton({ variant: "outline" })}
          >
            Publish a template
          </a>
        </div>

        {!catalog.ok ? (
          <Notice
            title="Templates are temporarily unavailable"
            body="The gallery could not be loaded. Try again in a moment."
          />
        ) : catalog.templates.length ? (
          <div className="grid gap-x-8 gap-y-12 sm:grid-cols-2 lg:grid-cols-3">
            {catalog.templates.map((item) => (
              <TemplateCard key={item.id} item={item} />
            ))}
          </div>
        ) : page ? (
          <Notice
            title="No more templates"
            body="Return to the previous page to keep browsing."
          />
        ) : (
          <Notice
            title="The library is taking shape"
            body="Be among the first to share a template. Each snapshot is reviewed before it appears here."
          />
        )}

        <nav aria-label="Template pages" className="mt-12 flex gap-4">
          {page > 0 && (
            <Link
              to="/templates"
              search={{ page: page - 1 || undefined }}
              className={linkButton({ variant: "outline" })}
            >
              Previous
            </Link>
          )}
          {catalog.ok && catalog.hasNext && (
            <Link
              to="/templates"
              search={{ page: page + 1 }}
              className={linkButton({ variant: "outline" })}
            >
              Next
            </Link>
          )}
        </nav>
      </main>
    </Page>
  );
}

// Each card links to the template's page on the app, which opens a copy and
// sends signed-out visitors through sign-in or account creation first.
function TemplateCard({ item }: { item: PublicTemplate }) {
  return (
    <article>
      <a
        href={appPath(`/template/${item.id}`)}
        className="group block rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4"
      >
        <div className="bg-muted overflow-hidden rounded-lg border">
          {item.previewStatus === "ready" ? (
            <img
              src={appPath(`/api/templates/${item.id}/preview`)}
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
      </a>
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
  );
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <section className="border-y py-16">
      <h2 className="text-2xl font-medium">{title}</h2>
      <p className="text-muted-foreground mt-3">{body}</p>
    </section>
  );
}
