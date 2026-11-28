import { useNavigate, useRouter } from "@tanstack/react-router";
import { useRef, useState } from "react";

import type { getOrganizations } from "#/lib/auth/organization.functions";
import { mainOrgRole } from "#/lib/auth/roles";

type Overview = Awaited<ReturnType<typeof getOrganizations>>;
export type Organization = NonNullable<Overview["selected"]>;
export type Member = Organization["members"][number];
export type Confirmation =
  | { kind: "remove"; member: Member }
  | { kind: "leave" }
  | { kind: "delete" };

/** Throws what the auth client returned instead of throwing. */
export function check(
  result: { error: { message?: string } | null },
  message: string,
) {
  if (result.error) throw new Error(result.error.message || message);
}

/** The user's place in an organization, and one change to it at a time. */
export function useOrganization(organization: Organization, userId: string) {
  const router = useRouter();
  const navigate = useNavigate({ from: "/settings/organizations" });
  const role = mainOrgRole(organization.role);
  const isOwner = role === "owner";
  const canManage = role !== "member";
  const owners = organization.members.filter(
    (member) => mainOrgRole(member.role) === "owner",
  ).length;
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  async function run(action: () => Promise<string | void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError("");
    setStatus("");
    try {
      setStatus((await action()) ?? "");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The organization could not be updated. Try again.",
      );
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return {
    organization,
    userId,
    isOwner,
    canManage,
    soleOwner: isOwner && owners === 1,
    owners,
    pending,
    error,
    status,
    confirmation,
    /** Runs a change. It may resolve to what to tell the user. */
    run,
    refresh: () => router.invalidate(),
    confirm(next: Confirmation) {
      setError("");
      setConfirmation(next);
    },
    closeConfirmation: () => setConfirmation(null),
    /** Call once the user is no longer in the organization. */
    async left() {
      setConfirmation(null);
      await navigate({ search: {}, replace: true });
      await router.invalidate();
    },
  };
}

export type OrganizationState = ReturnType<typeof useOrganization>;
