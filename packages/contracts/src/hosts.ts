// Where each Texfolia app is served. `app` is the product and owns
// all auth; `web` is marketing and uses none.
// Production: texfolia.com and www.texfolia.com serve `web`, and
// app.texfolia.com serves `app`. Locally, `web` runs on 4321 and `app` on 3000.
export const productionHosts = {
  app: "https://app.texfolia.com",
  web: ["https://texfolia.com", "https://www.texfolia.com"],
} as const;

export const localHosts = {
  app: "http://localhost:3000",
  web: ["http://localhost:4321"],
} as const;
