// Where each Texfolia app is served. `app` owns auth; `web` is marketing.
// Production: texfolia.com and www.texfolia.com serve `web`, and
// app.texfolia.com serves `app`. Locally, `web` runs on 4321 and `app` on 3000.
export const productionHosts = {
  app: "https://app.texfolia.com",
  web: ["https://texfolia.com", "https://www.texfolia.com"],
  // Sessions are shared by every *.texfolia.com host.
  cookieDomain: "texfolia.com",
} as const;

export const localHosts = {
  app: "http://localhost:3000",
  web: ["http://localhost:4321"],
} as const;
