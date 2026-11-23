import {
  clearCollaborationCaches,
  stopDocumentCaching,
} from "#/features/collaboration/browser";

import { authClient } from "./auth-client";

export async function signOut(userId: string) {
  const result = await authClient.signOut();
  if (result.error) throw new Error("Could not sign out. Try again.");
  stopDocumentCaching();
  try {
    await clearCollaborationCaches(userId);
  } catch {
    throw new Error(
      "You are signed out, but local document copies could not be removed. Close other Texfolia tabs and choose Sign out to retry. If this continues, clear Texfolia’s site data in your browser.",
    );
  }
}
