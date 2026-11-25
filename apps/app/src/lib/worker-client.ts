// Distributes, so each member of a request union keeps its own fields.
type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;

/**
 * Sends requests to a worker that starts on first use and answers each with the
 * request's `id`. A worker that fails is terminated, its requests reject with
 * `failure`, and the next request starts another.
 */
export function createWorkerClient<
  Request extends { id: number },
  Response extends { id: number },
>(createWorker: () => Worker, failure: string) {
  let worker: Worker | undefined;
  let nextId = 0;
  const pending = new Map<
    number,
    { resolve: (response: Response) => void; reject: (error: Error) => void }
  >();

  function start() {
    const instance = createWorker();
    instance.onmessage = ({ data }: MessageEvent<Response>) => {
      const request = pending.get(data.id);
      pending.delete(data.id);
      request?.resolve(data);
    };
    instance.onerror = instance.onmessageerror = () => {
      if (worker !== instance) return;
      worker = undefined;
      instance.terminate();
      const failed = [...pending.values()];
      pending.clear();
      for (const { reject } of failed) reject(new Error(failure));
    };
    worker = instance;
    return instance;
  }

  return (message: WithoutId<Request>) =>
    new Promise<Response>((resolve, reject) => {
      const target = worker ?? start();
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      try {
        target.postMessage({ ...message, id });
      } catch (error) {
        pending.delete(id);
        throw error;
      }
    });
}
