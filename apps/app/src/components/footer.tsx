import { webPath } from "#/lib/origins";

export function Footer() {
  return (
    <footer className="mt-auto border-t">
      <div className="mx-auto flex max-w-7xl flex-col justify-between gap-6 px-6 py-10 text-sm sm:flex-row sm:items-center sm:px-8">
        <div>
          <a
            href={webPath("/")}
            className="text-foreground font-serif text-2xl"
          >
            Texfolia.
          </a>
          <p className="text-muted-foreground mt-2">
            A little more space to think.
          </p>
        </div>
        <nav
          aria-label="Footer"
          className="text-muted-foreground [&_a:hover]:text-foreground flex flex-wrap gap-x-6 gap-y-3 [&_a]:underline-offset-4 [&_a:focus-visible]:outline-2 [&_a:focus-visible]:outline-offset-4 [&_a:hover]:underline"
        >
          <a href={webPath("/pricing")}>Pricing</a>
          <a href={webPath("/privacy")}>Privacy</a>
          <a href={webPath("/terms")}>Terms</a>
        </nav>
        <p className="text-muted-foreground text-xs">
          © {new Date().getFullYear()} Texfolia
        </p>
      </div>
    </footer>
  );
}
