// How long a live channel may serve a verified user without asking Postgres again.
// Revocation paths push via invalidateAccess, so this only bounds a missed notice
// on active traffic.
export const liveAccessMs = 15 * 60_000;
