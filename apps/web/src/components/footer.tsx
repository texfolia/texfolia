import { Link } from "@tanstack/react-router";

export function Footer() {
  return (
    <footer className="mt-auto border-t">
      <div className="mx-auto flex max-w-7xl flex-col justify-between gap-6 px-6 py-10 text-sm sm:flex-row sm:items-center sm:px-8">
        <div>
          <Link to="/" className="text-foreground font-serif text-2xl">
            Texfolia.
          </Link>
          <p className="text-muted-foreground mt-2">
            A little more space to think.
          </p>
        </div>
        <nav
          aria-label="Footer"
          className="text-muted-foreground [&_a:hover]:text-foreground flex flex-wrap gap-x-6 gap-y-3 [&_a]:underline-offset-4 [&_a:focus-visible]:outline-2 [&_a:focus-visible]:outline-offset-4 [&_a:hover]:underline"
        >
          <Link to="/templates" search={{ page: 0 }}>
            Templates
          </Link>
          <Link to="/pricing">Pricing</Link>
          <Link to="/privacy">Privacy</Link>
          <Link to="/terms">Terms</Link>
        </nav>
        <p className="text-muted-foreground text-xs">
          © {new Date().getFullYear()} Texfolia
        </p>
      </div>
    </footer>
  );
}
