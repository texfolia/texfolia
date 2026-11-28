import { createFileRoute, Link, useRouter } from "@tanstack/react-router";

import { Button } from "#/components/ui/button";
import { getOrganizations } from "#/lib/auth/organization.functions";

import { OrganizationSettings } from "./-components/organization-settings";

export const Route = createFileRoute("/settings/organizations")({
  // The router keeps raw search values that a validator omits.
  validateSearch: (
    search: Record<string, unknown>,
  ): { organizationId?: string } => ({
    organizationId:
      typeof search.organizationId === "string" && search.organizationId
        ? search.organizationId
        : undefined,
  }),
  loaderDeps: ({ search }) => ({ organizationId: search.organizationId }),
  loader: ({ deps }) => getOrganizations({ data: deps }),
  head: () => ({ meta: [{ title: "Organizations | Texfolia" }] }),
  component: OrganizationsPage,
  errorComponent: OrganizationError,
});

function OrganizationError() {
  const router = useRouter();
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Organization unavailable</h2>
      <p className="text-muted-foreground text-sm">
        Check your connection and make sure you're a member of the organization.
      </p>
      <div className="flex gap-3">
        <Button onClick={() => void router.invalidate()}>Try again</Button>
        <Button
          variant="outline"
          render={<Link to="/settings/organizations" search={{}} />}
        >
          Your organizations
        </Button>
      </div>
    </div>
  );
}

function OrganizationsPage() {
  const { organizations, selected, userId } = Route.useLoaderData();
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold">Organizations</h2>
        <p className="text-muted-foreground mt-2 text-sm">
          Members open the organization's projects with the access each project
          gives everyone in the organization, their teams, or them. Admins can
          edit every project and manage members, teams, sharing, and billing.
          Owners also manage roles and can delete the organization.
        </p>
      </div>
      <nav aria-label="Organization" className="flex flex-wrap gap-3">
        {organizations.map((organization) => (
          <Button
            key={organization.id}
            variant={selected?.id === organization.id ? "default" : "outline"}
            render={
              <Link
                to="/settings/organizations"
                search={{ organizationId: organization.id }}
              />
            }
          >
            {organization.name}
          </Button>
        ))}
        <Button
          variant="outline"
          render={<Link to="/settings/billing" search={{ plan: "team" }} />}
        >
          New organization
        </Button>
      </nav>
      {selected ? (
        <OrganizationSettings
          key={selected.id}
          organization={selected}
          userId={userId}
        />
      ) : (
        <p className="text-sm">You aren't in an organization.</p>
      )}
    </div>
  );
}
