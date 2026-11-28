import { describe, expect, test } from "bun:test";

import {
  fetchGatewayModels,
  gatewayModels,
  parseAiConfig,
  type AiFetch,
  type AiConfig,
} from "./gateway.server";
const config: AiConfig = {
  accountId: "a".repeat(32),
  gatewayId: "test",
  apiToken: "test",
  stripeKey: "test",
  priceId: "price_test",
  meterEventName: "test",
};
const model = {
  id: "@cf/test/model",
  name: "Test model",
  pricing: { prompt: "0.000001", completion: "0.000002" },
  supported_parameters: ["tools", "max_tokens"],
  architecture: { input_modalities: ["text"], output_modalities: ["text"] },
};
test("refuses missing or malformed settings as unconfigured", () => {
  expect(parseAiConfig(config)).toEqual(config);
  for (const values of [
    { ...config, apiToken: undefined },
    { ...config, accountId: "not-an-account" },
    { ...config, priceId: "prod_test" },
  ])
    expect(() => parseAiConfig(values)).toThrow("not configured");
});
describe("AI Gateway catalog", () => {
  test("offers only text models with tools, bounded output, and known token prices", async () => {
    const fetcher: AiFetch = async () =>
      Response.json({
        data: [
          model,
          { ...model, id: "no-tools", supported_parameters: [] },
          {
            ...model,
            id: "unknown-price",
            pricing: { prompt: null, completion: null },
          },
          {
            ...model,
            id: "extra-fee",
            pricing: { ...model.pricing, request: "1" },
          },
          {
            ...model,
            id: "image",
            architecture: {
              ...model.architecture,
              output_modalities: ["image"],
            },
          },
        ],
      });
    expect(await fetchGatewayModels(config, fetcher)).toEqual([
      {
        id: model.id,
        name: model.name,
        inputPrice: 0.000001,
        outputPrice: 0.000002,
      },
    ]);
  });
  test("handles catalog responses that return all models rather than pages", async () => {
    let calls = 0;
    const fetcher: AiFetch = async () => {
      calls++;
      return Response.json({
        data: Array.from({ length: 101 }, (_, i) => ({
          ...model,
          id: String(i),
        })),
      });
    };
    expect((await fetchGatewayModels(config, fetcher)).length).toBe(101);
    expect(calls).toBe(1);
  });
  test("bounds sequential pagination requests", async () => {
    let calls = 0;
    const fetcher: AiFetch = async () => {
      const page = ++calls;
      return Response.json({
        data: Array.from({ length: 100 }, (_, i) => ({
          ...model,
          id: `${page}-${i}`,
        })),
      });
    };
    expect((await fetchGatewayModels(config, fetcher)).length).toBe(500);
    expect(calls).toBe(5);
  });
  test("never falls back to a hardcoded catalog after an API failure", async () => {
    const fetcher: AiFetch = async () => new Response(null, { status: 401 });
    await expect(fetchGatewayModels(config, fetcher)).rejects.toThrow("401");
  });
});

describe("model catalog cache", () => {
  function setup() {
    const stored = new Map<string, Response>();
    let now = Date.now();
    let fetches = 0;
    return {
      fetches: () => fetches,
      pass: (ms: number) => (now += ms),
      options: {
        now: () => now,
        fetcher: async () => {
          fetches++;
          return Response.json({ data: [model] });
        },
        cache: {
          match: async (key: unknown) => stored.get(String(key))?.clone(),
          put: async (key: unknown, response: Response) => {
            stored.set(String(key), response);
          },
        } as Pick<Cache, "match" | "put">,
      },
    };
  }

  test("fetches once within ten minutes, and again afterward", async () => {
    const account = { ...config, accountId: "1".repeat(32) };
    const { options, fetches, pass } = setup();
    const first = await gatewayModels(account, options);
    expect(first[0]?.id).toBe(model.id);
    pass(9 * 60_000);
    expect(await gatewayModels(account, options)).toEqual(first);
    expect(fetches()).toBe(1);
    pass(2 * 60_000);
    await gatewayModels(account, options);
    expect(fetches()).toBe(2);
  });

  test("keeps accounts apart and does not cache a failure", async () => {
    const { options, fetches } = setup();
    const account = { ...config, accountId: "2".repeat(32) };
    await expect(
      gatewayModels(account, {
        ...options,
        fetcher: async () => new Response(null, { status: 500 }),
      }),
    ).rejects.toThrow("500");
    await gatewayModels(account, options);
    await gatewayModels({ ...config, accountId: "3".repeat(32) }, options);
    expect(fetches()).toBe(2);
  });

  test("still works when the shared cache does not", async () => {
    const { options } = setup();
    const fail = async () => {
      throw new Error("cache unavailable");
    };
    expect(
      await gatewayModels(
        { ...config, accountId: "4".repeat(32) },
        { ...options, cache: { match: fail, put: fail } },
      ),
    ).toHaveLength(1);
  });
});
