import type { Model } from "@oh-my-pi/pi-ai";
import { resolveCodexResponsesLite } from "@oh-my-pi/pi-ai/providers/openai-codex/request-transformer";
import { bareModelId, parseOpenAIModel, semverEqual } from "@oh-my-pi/pi-catalog/identity";

export type OpenAICodexGpt56EvalProfile = "sol-hybrid" | "code-mode-only";

/** Whether task guidance should follow Codex's GPT-5.6-specific delegation policy. */
export function usesCodexTaskPrompt(modelId: string | undefined): boolean {
	if (!modelId) return false;
	const parsed = parseOpenAIModel(bareModelId(modelId));
	return parsed !== null && semverEqual(parsed.version, "5.6");
}

/** Resolve the exact-model eval surface evidenced by the live GPT-5.6 Codex catalog. */
export function openAICodexGpt56EvalProfile(model: Model | undefined): OpenAICodexGpt56EvalProfile | null {
	if (model?.provider !== "openai-codex" || model.api !== "openai-codex-responses") return null;
	if (!resolveCodexResponsesLite(model as Model<"openai-codex-responses">, undefined)) return null;

	switch (bareModelId(model.id)) {
		case "gpt-5.6-sol":
			return "sol-hybrid";
		case "gpt-5.6-terra":
		case "gpt-5.6-luna":
			return "code-mode-only";
		default:
			return null;
	}
}

/** Whether the bounded parallel hint applies to the Sol hybrid route. */
export function usesOpenAICodexGpt56SolLitePrompt(model: Model | undefined): boolean {
	return openAICodexGpt56EvalProfile(model) === "sol-hybrid";
}
