import { afterEach, describe, expect, test } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";

interface CodexModelInfo {
	slug: string;
	display_name: string;
	description: string | null;
	supported_reasoning_levels: Array<{ effort: string; description: string }>;
	shell_type: string;
	visibility: string;
	supported_in_api: boolean;
	priority: number;
	availability_nux: unknown;
	upgrade: unknown;
	base_instructions: string;
	support_verbosity: boolean;
	default_verbosity: unknown;
	apply_patch_tool_type: unknown;
	truncation_policy: { mode: string; limit: number };
	supports_parallel_tool_calls: boolean;
	experimental_supported_tools: string[];
	input_modalities: string[];
}

describe("auth-gateway Codex model catalog", () => {
	let close: (() => Promise<void>) | undefined;

	afterEach(async () => {
		await close?.();
		close = undefined;
	});

	test("returns Codex ModelsResponse metadata with ETag revalidation", async () => {
		const model = getBundledModels("anthropic")[0];
		if (!model) throw new Error("bundled anthropic model missing");
		const handle = startAuthGateway({
			storage: {} as AuthStorage,
			bind: "127.0.0.1:0",
			bearerTokens: ["gateway-test-token"],
			resolveModel: id => (id === `${model.provider}/${model.id}` ? model : undefined),
			listModels: () => [model],
		});
		close = handle.close;

		const response = await fetch(`${handle.url}/v1/models`, {
			headers: { Authorization: "Bearer gateway-test-token" },
		});
		expect(response.status).toBe(200);
		const etag = response.headers.get("etag");
		expect(etag).toMatch(/^"[0-9a-f-]+"$/);
		const body = (await response.json()) as { models: CodexModelInfo[]; data?: unknown };
		expect(body.data).toBeUndefined();
		expect(body.models).toHaveLength(1);
		expect(body.models[0]).toMatchObject({
			slug: `${model.provider}/${model.id}`,
			display_name: model.name,
			shell_type: "default",
			visibility: "list",
			supported_in_api: true,
			truncation_policy: { mode: "tokens", limit: model.contextWindow },
			input_modalities: model.input,
		});
		expect(body.models[0].base_instructions.length).toBeGreaterThan(0);
		expect(Array.isArray(body.models[0].supported_reasoning_levels)).toBe(true);

		const notModified = await fetch(`${handle.url}/v1/models`, {
			headers: {
				Authorization: "Bearer gateway-test-token",
				"If-None-Match": etag!,
			},
		});
		expect(notModified.status).toBe(304);
		expect(await notModified.text()).toBe("");
	});
});
