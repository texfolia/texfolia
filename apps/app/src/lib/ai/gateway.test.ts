import { describe, expect, test } from "bun:test";

import { gatewayModels, type AiFetch, type AiConfig } from "./gateway.server";
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
    expect(await gatewayModels(config, fetcher)).toEqual([
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
    expect((await gatewayModels(config, fetcher)).length).toBe(101);
    expect(calls).toBe(2);
  });
  test("never falls back to a hardcoded catalog after an API failure", async () => {
    const fetcher: AiFetch = async () => new Response(null, { status: 401 });
    await expect(gatewayModels(config, fetcher)).rejects.toThrow("401");
  });
});
