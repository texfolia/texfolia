# Marketing site

Astro marketing site for Texfolia, deployed to Cloudflare Workers as `texfolia-web`.

```sh
cp apps/web/.env.example apps/web/.env
bun run --cwd apps/web dev
```

Open [localhost:4321](http://localhost:4321). Login and product CTAs point at
`PUBLIC_APP_URL` (default `http://localhost:3000`). The templates gallery
fetches `GET /api/templates` from the product app.
