// How long a live channel may serve a verified user without asking Postgres again.
// Revocation paths push, so this only bounds a missed notice.
export const liveAccessMs = 60_000;
