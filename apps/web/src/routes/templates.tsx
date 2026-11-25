import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Button } from "@texfolia/ui/button";
import { Input } from "@texfolia/ui/input";
import { NativeSelect, NativeSelectOption } from "@texfolia/ui/native-select";

import { Page } from "#/components/page";
import { pageHead } from "#/lib/head";
import { linkButton } from "#/lib/link-button";
import {
  fetchTemplateCatalog,
  maxTemplateQuery,
  maxTemplateTag,
  parseTemplateSearch,
  templateLicenses,
  type PublicTemplate,
  type TemplateSearch,
} from "#/lib/templates";
import { appPath, appUrl } from "#/lib/urls";

// Runs on the web Worker, so browsers never call the app's API cross-origin.
const loadTemplates = createServerFn({ method: "GET" })
  .validator((search: TemplateSearch) => parseTemplateSearch(search))
  .handler(({ data: search }) => fetchTemplateCatalog(appUrl(), search));

// The widest layout's columns.
const firstRow = 3;

export const Route = createFileRoute("/templates")({
  // Always returns every key: the router keeps raw search values a validator omits.
  validateSearch: parseTemplateSearch,
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => ({
    search: deps,
    catalog: await loadTemplates({ data: deps }),
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
  const { search, catalog } = Route.useLoaderData();
  const { page = 0, q, tag, license } = search;
  const filtered = !!(q || tag || license);
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

        {/* Remounted per search, so that the fields always show it. */}
        <Filters key={JSON.stringify([q, tag, license])} search={search} />

        {!catalog.ok ? (
          <Notice
            title="Templates are temporarily unavailable"
            body="The gallery could not be loaded. Try again in a moment."
          />
        ) : catalog.templates.length ? (
          <div className="grid gap-x-8 gap-y-12 sm:grid-cols-2 lg:grid-cols-3">
            {catalog.templates.map((item, index) => (
              <TemplateCard
                key={item.id}
                item={item}
                eager={index < firstRow}
              />
            ))}
          </div>
        ) : page ? (
          <Notice
            title="No more templates"
            body="Return to the previous page to keep browsing."
          />
        ) : filtered ? (
          <Notice
            title="No matching templates"
            body="Try fewer words, or clear a filter."
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
              search={{ ...search, page: page - 1 || undefined }}
              className={linkButton({ variant: "outline" })}
            >
              Previous
            </Link>
          )}
          {catalog.ok && catalog.hasNext && (
            <Link
              to="/templates"
              search={{ ...search, page: page + 1 }}
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

// A plain GET form, so filtering works before the page hydrates.
function Filters({ search }: { search: TemplateSearch }) {
  const navigate = Route.useNavigate();
  return (
    <search className="mb-12 block">
      <form
        method="get"
        action="/templates"
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void navigate({
            search: parseTemplateSearch(
              Object.fromEntries(new FormData(event.currentTarget)),
            ),
          });
        }}
      >
        <label className="min-w-0 flex-1 basis-60 space-y-1 text-sm">
          <span className="font-medium">Search</span>
          <Input
            type="search"
            name="q"
            maxLength={maxTemplateQuery}
            placeholder="Title, description or publisher"
            defaultValue={search.q ?? ""}
          />
        </label>
        <label className="min-w-0 flex-1 basis-40 space-y-1 text-sm">
          <span className="font-medium">Tag</span>
          <Input
            name="tag"
            maxLength={maxTemplateTag}
            placeholder="thesis"
            defaultValue={search.tag ?? ""}
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="block font-medium">License</span>
          <NativeSelect name="license" defaultValue={search.license ?? ""}>
            <NativeSelectOption value="">Any license</NativeSelectOption>
            {Object.entries(templateLicenses).map(([id, label]) => (
              <NativeSelectOption key={id} value={id}>
                {label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
        <Button type="submit">Filter</Button>
        {(search.q || search.tag || search.license) && (
          <Link
            to="/templates"
            search={{}}
            className={linkButton({ variant: "outline" })}
          >
            Clear
          </Link>
        )}
      </form>
    </search>
  );
}

// Each card links to the template's page on the app, which opens a copy and
// sends signed-out visitors through sign-in or account creation first.
function TemplateCard({
  item,
  eager,
}: {
  item: PublicTemplate;
  /** Whether the card is on screen at first, where lazy loading only delays it. */
  eager: boolean;
}) {
  return (
    <article>
      <a
        href={appPath(`/template/${item.id}`)}
        className="group block rounded-lg focus-visible:outline-2 focus-visible:outline-offset-4"
      >
        <div className="bg-muted overflow-hidden rounded-lg border">
          {item.previewStatus === "ready" ? (
            <img
              src={appPath(`/api/templates/${item.id}/preview?size=thumbnail`)}
              alt={`First page of ${item.title}`}
              loading={eager ? "eager" : "lazy"}
              fetchPriority={eager ? "high" : "auto"}
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
          <li key={tag}>
            <Link
              to="/templates"
              search={{ tag }}
              className="bg-muted hover:text-foreground block rounded px-2 py-1 hover:underline"
            >
              {tag}
            </Link>
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
