import { Link } from "@tanstack/react-router";

// Shown for share links that were revoked, whose project was deleted, or that
// were never valid.
export function LinkNoLongerWorks() {
  return (
    <main
      id="main-content"
      className="mx-auto flex min-h-svh max-w-xl flex-col justify-center gap-4 px-6"
    >
      <h1 className="text-2xl">This link no longer works</h1>
      <p className="text-muted-foreground">
        The owner may have revoked it, or the project was deleted. Ask them for
        a new link.
      </p>
      <Link to="/" className="underline">
        Go to Texfolia
      </Link>
    </main>
  );
}
