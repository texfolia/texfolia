/** The container platform: Cloudflare Containers, or Docker in development. */
export interface ContainerPlatform {
  /** Starts a container and waits until it serves requests. */
  start(name: string, signal?: AbortSignal): Promise<void>;
  stop(name: string, signal?: AbortSignal): Promise<void>;
  fetch(
    name: string,
    request: Request,
    signal?: AbortSignal,
  ): Promise<Response>;
}
