---
version: 1
slug: "apps-web-src-routes-login-route-tsx"
primary_target: "apps/app/src/routes/login/route.tsx"
related_targets: []
---

# Login

Mode: Operate. Scope: `/login`; invitation and marketing pages stay unchanged.
Nate's direction: very simple and minimal, subtle animations, Linear sign-in inspiration, and official full-color provider marks, including GitLab's icon assets.

## Direction contract

THESIS: One compact sign-in column, with no promotional split or decorative card. Keep every existing auth method and recovery state.

OWN-WORLD: Existing neutral semantic colors, Nova controls, and loaded Inter for both the Texfolia wordmark and headings. Official provider logo colors remain intact.

STORY: Choose a provider or enter an email, then explicitly verify the emailed code. Errors and security-check recovery stay next to the relevant controls.

FIRST VIEWPORT: A centered column up to 320px wide, sans wordmark, modest title, stacked provider buttons, centered form text and OTP slots, CAPTCHA without helper copy, and a quiet legal sentence linking Privacy Policy and Terms of Service. On short or narrow screens the document scrolls naturally.

FORM: User-specified composition inspired by Linear's sign-in page; no concept tournament. seed: none (user-pinned direction). The signature interaction is a short fade when changing email/OTP steps; reduced-motion preference suppresses it.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

Preserve the editor-scoped DESIGN.md. This surface extends the existing Inter, semantic-color, and Nova component system rather than changing the global system. The Google logo is an official sourced PNG with embedded origin metadata; the other provider marks are sourced SVGs.
