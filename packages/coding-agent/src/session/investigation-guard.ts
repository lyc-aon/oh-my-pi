import type { AfterToolCallContext, BeforeToolCallContext, BeforeToolCallResult } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, TextContent, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { countTokens } from "@oh-my-pi/pi-natives";
import type { Settings } from "../config/settings";

const READ_TOOL_NAME = "read";

/**
 * Read-only tools whose calls count toward an investigation streak. A turn
 * counts as "investigation" only when every tool it executed is in this table;
 * any other tool (edit, write, bash, todo, task, MCP, ...) is treated as the
 * agent making progress and resets the guard entirely.
 */
const INVESTIGATION_TOOLS: Record<string, true> = {
	[READ_TOOL_NAME]: true,
	search: true,
	find: true,
	ast_grep: true,
	lsp: true,
	web_search: true,
	inspect_image: true,
};

/** Tool-choice queue label used when the investigation guard forces a synthesis turn. */
export const INVESTIGATION_GUARD_TOOL_CHOICE_LABEL = "investigation-guard";

interface InvestigationGuardLimits {
	enabled: boolean;
	maxReadCalls: number;
	maxReadTokens: number;
	maxInvestigationTurns: number;
}

type SynthesisTrigger = "read-call" | "read-token";

/**
 * Detects unbounded investigation spirals (#2234: 77 consecutive read/search
 * turns, zero text answers, context and thinking growing until the session
 * went silent) and asks the model to synthesize before context blows up:
 *
 * - Read budget per investigation streak: too many `read` calls or too many
 *   read-output tokens means the agent should stop pulling more files into
 *   context and answer from what it has.
 * - Investigation-turn cap: consecutive assistant turns whose tool calls are
 *   all read-only investigation tools. Once the cap is reached the next LLM
 *   call is forced with `toolChoice: "none"` so the model must produce text.
 *
 * Any turn that executes a non-investigation tool resets all counters —
 * normal coding work (read a few files, edit, run tests, read more) never
 * accumulates a streak, no matter how long the session runs.
 */
export class InvestigationGuard {
	readonly #settings: Settings;
	#readCalls = 0;
	#readTokens = 0;
	#investigationTurns = 0;
	/**
	 * Read calls that passed `beforeToolCall` but have not completed yet.
	 * Same-message reads run concurrently, so the call budget must count
	 * in-flight reads — `#readCalls` alone lags until results land. The token
	 * budget cannot be projected the same way (output size is unknown until a
	 * read completes), so within one concurrent batch it can overshoot by at
	 * most the remaining call budget; the synthesis turn forced right after
	 * the batch bounds the damage.
	 */
	readonly #pendingReads = new Set<string>();
	#synthesisRequested = false;

	constructor(settings: Settings) {
		this.#settings = settings;
	}

	/** Clear all counters: new prompt, text answer, or a productive (non-investigation) turn. */
	reset(): void {
		this.#readCalls = 0;
		this.#readTokens = 0;
		this.#investigationTurns = 0;
		this.#pendingReads.clear();
		this.#synthesisRequested = false;
	}

	/** Block read calls that exceed the current investigation budget. */
	beforeToolCall(ctx: BeforeToolCallContext): BeforeToolCallResult | undefined {
		if (ctx.toolCall.name !== READ_TOOL_NAME) return undefined;
		const limits = this.#limits();
		if (!limits.enabled) return undefined;

		const projectedReadCalls = this.#readCalls + this.#pendingReads.size + 1;
		const callLimitExceeded = projectedReadCalls > limits.maxReadCalls;
		const tokenLimitExceeded = this.#readTokens >= limits.maxReadTokens;
		if (!callLimitExceeded && !tokenLimitExceeded) {
			this.#pendingReads.add(ctx.toolCall.id);
			return undefined;
		}

		this.#synthesisRequested = true;
		return {
			block: true,
			reason: this.#blockReason(limits, callLimitExceeded ? "read-call" : "read-token"),
		};
	}

	/** Account for read-tool output and request synthesis once accumulated output crosses the token budget. */
	afterToolCall(ctx: AfterToolCallContext): void {
		if (ctx.toolCall.name !== READ_TOOL_NAME) return;
		this.#pendingReads.delete(ctx.toolCall.id);
		if (ctx.isError) return;
		const limits = this.#limits();
		if (!limits.enabled) return;

		this.#readCalls++;
		const texts = ctx.result.content.filter((content): content is TextContent => content.type === "text");
		if (texts.length > 0) {
			this.#readTokens += countTokens(texts.map(content => content.text));
		}
		if (this.#readTokens >= limits.maxReadTokens || this.#readCalls >= limits.maxReadCalls) {
			this.#synthesisRequested = true;
		}
	}

	/**
	 * Classify a completed assistant turn by the tools it actually executed
	 * (not `stopReason` — interleaved-thinking models routinely emit tool
	 * calls under `end_turn`):
	 *
	 * - All executed tools are investigation tools → the streak grows and may
	 *   request synthesis.
	 * - Any non-investigation tool ran → the agent made progress; reset.
	 * - No tools and a clean `stop` → the agent answered in text; reset.
	 * - `error`/`aborted` turns leave counters untouched.
	 */
	noteTurnEnd(message: AssistantMessage, toolResults: readonly ToolResultMessage[]): void {
		if (message.stopReason === "error" || message.stopReason === "aborted") return;
		if (toolResults.length === 0) {
			if (message.stopReason === "stop") this.reset();
			return;
		}
		if (!toolResults.every(result => INVESTIGATION_TOOLS[result.toolName] === true)) {
			this.reset();
			return;
		}
		this.#investigationTurns++;
		const limits = this.#limits();
		if (limits.enabled && this.#investigationTurns >= limits.maxInvestigationTurns) {
			this.#synthesisRequested = true;
		}
	}

	/** Consume the pending request to force the next LLM call to run without tools. */
	consumeSynthesisRequest(): boolean {
		if (!this.#synthesisRequested) return false;
		this.#synthesisRequested = false;
		return true;
	}

	#limits(): InvestigationGuardLimits {
		const maxReadCalls = Math.max(1, Math.floor(this.#settings.get("investigationGuard.maxReadCalls")));
		const maxReadTokens = Math.max(1, Math.floor(this.#settings.get("investigationGuard.maxReadTokens")));
		const maxInvestigationTurns = Math.max(
			1,
			Math.floor(this.#settings.get("investigationGuard.maxInvestigationTurns")),
		);
		return {
			enabled: this.#settings.get("investigationGuard.enabled"),
			maxReadCalls,
			maxReadTokens,
			maxInvestigationTurns,
		};
	}

	#blockReason(limits: InvestigationGuardLimits, trigger: SynthesisTrigger): string {
		const detail =
			trigger === "read-call" ? `${limits.maxReadCalls} read calls` : `${limits.maxReadTokens} read-output tokens`;
		return `Read investigation limit reached after ${detail} without intervening progress. Stop reading more files and answer from the evidence already gathered; if exact missing lines are required, explain the narrow follow-up read instead of continuing the tool loop.`;
	}
}
