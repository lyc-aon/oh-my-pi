import { describe, expect, it } from "bun:test";
import { resolveOpenAICodexReasoningEffort, streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { createCodexModel } from "./helpers";

const context: Context = {
	messages: [{ role: "user", content: "Say OK", timestamp: 0 }],
};

function createCodexTestToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toBase64();
	return `aaa.${payload}.bbb`;
}

function createGpt56CodexTestModel(): Model<"openai-codex-responses"> {
	return buildModel({
		id: "gpt-5.6-sol",
		name: "GPT-5.6 Sol",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://codex.example.test/backend-api",
		reasoning: true,
		useResponsesLite: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 372_000,
		maxTokens: 128_000,
	});
}

function completedCodexResponse(): Response {
	const events = [
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				id: "msg_1",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: "OK" }],
			},
		},
		{
			type: "response.completed",
			response: {
				status: "completed",
				usage: {
					input_tokens: 1,
					output_tokens: 1,
					total_tokens: 2,
					input_tokens_details: { cached_tokens: 0 },
				},
			},
		},
	];
	return new Response(`${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

describe("openai-codex explicit reasoning disablement", () => {
	it("maps GPT-5.6 off to the explicit none wire effort", () => {
		const model = createCodexModel("gpt-5.6-sol");

		expect(resolveOpenAICodexReasoningEffort(model, { disableReasoning: true })).toBe("none");
		expect(
			resolveOpenAICodexReasoningEffort(model, {
				disableReasoning: true,
				reasoning: Effort.High,
			}),
		).toBe("none");
	});

	it("keeps fixed GPT-5.6 efforts 1:1", () => {
		const model = createCodexModel("gpt-5.6-terra");

		expect(resolveOpenAICodexReasoningEffort(model, { reasoning: Effort.Low })).toBe(Effort.Low);
		expect(resolveOpenAICodexReasoningEffort(model, { reasoning: Effort.Max })).toBe(Effort.Max);
	});

	it("does not change pre-5.6 disablement semantics", () => {
		const model = createCodexModel("gpt-5.5");

		expect(resolveOpenAICodexReasoningEffort(model, { disableReasoning: true })).toBeUndefined();
	});

	it("carries explicit off through streamSimple into the transformed Lite request", async () => {
		const model = createGpt56CodexTestModel();
		let body: Record<string, unknown> | undefined;
		const fetchMock: FetchImpl = async (_input, init) => {
			body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
			return completedCodexResponse();
		};

		for await (const event of streamSimple(model, context, {
			apiKey: createCodexTestToken(),
			disableReasoning: true,
			fetch: fetchMock,
			preferWebsockets: false,
		})) {
			if (event.type === "done" || event.type === "error") break;
		}

		expect(body?.reasoning).toMatchObject({
			effort: "none",
			context: "all_turns",
		});
	});
});
