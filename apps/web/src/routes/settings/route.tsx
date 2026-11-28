import { IconArrowLeft } from "@tabler/icons-react";
import {
  createFileRoute,
  Link,
  Outlet,
  redirect,
} from "@tanstack/react-router";

import { settingsLinks } from "#/lib/settings/settings-navigation";
import { SettingsProvider } from "#/providers/settings-provider";
import { ThemeProvider } from "#/providers/theme-provider";

export const Route = createFileRoute("/settings")({
  ssr: false,
  beforeLoad: ({ context, location }) => {
    if (!context.appUser)
      throw redirect({ to: "/login", search: { redirectTo: location.href } });
    return { user: context.appUser };
  },
  head: () => ({ meta: [{ title: "Settings | Texfolia" }] }),
  component: SettingsLayout,
});
function SettingsLayout() {
  const { user } = Route.useRouteContext();
  return (
    <ThemeProvider userId={user.id}>
      <SettingsProvider userId={user.id}>
        <div className="bg-background text-foreground min-h-svh">
          <header className="flex min-h-16 items-center justify-between gap-4 border-b px-5 sm:px-8">
            <Link
              to="/projects"
              className="flex items-center gap-2 text-sm hover:underline"
            >
              <IconArrowLeft className="size-4" />
              Back to projects
            </Link>
            <span className="text-muted-foreground truncate text-sm">
              {user.email}
            </span>
          </header>
          <div className="mx-auto flex max-w-7xl flex-col gap-8 px-5 py-8 sm:flex-row sm:gap-12 sm:px-8">
            <aside className="shrink-0 sm:w-48">
              <h1 className="mb-5 text-2xl font-semibold tracking-tight">
                Settings
              </h1>
              <nav
                aria-label="Settings"
                className="flex flex-wrap gap-1 sm:flex-col"
              >
                {settingsLinks.map(({ to, label, icon: Icon }) => (
                  <Link
                    key={to}
                    to={to}
                    activeProps={{
                      className: "bg-accent text-accent-foreground",
                      "aria-current": "page",
                    }}
                    className="hover:bg-accent focus-visible:ring-ring flex items-center gap-2 rounded-lg px-3 py-2 text-sm outline-none focus-visible:ring-2"
                  >
                    <Icon className="size-4" />
                    {label}
                  </Link>
                ))}
              </nav>
            </aside>
            <main id="main-content" className="min-w-0 flex-1">
              <Outlet />
            </main>
          </div>
        </div>
      </SettingsProvider>
    </ThemeProvider>
  );
}
