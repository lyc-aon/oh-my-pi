import {
	SonificationPreset,
	SonificationRateResponse,
	SonificationVoice,
	TokenAudioEngine,
	type TokenAudioStatus,
} from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";
import { isSettingsInitialized, settings } from "../config/settings";

export const SONIFICATION_PRESETS = ["rotary", "geiger", "mechanical", "synth", "rain"] as const;
export type SonificationPresetName = (typeof SONIFICATION_PRESETS)[number];
export type SonificationSource = "assistant" | "thinking" | "tool-input" | "tool-output";
type SonificationLane = SonificationSource | "tool-success" | "tool-error";
type SonificationBlockId = string | number;

interface EstimatorState {
	estimatedTokenCredit: number;
	insideWord: boolean;
	wordBlockId: SonificationBlockId | undefined;
	lastDeltaAt: number;
}

const NATIVE_PRESETS: Record<SonificationPresetName, SonificationPreset> = {
	rotary: SonificationPreset.Rotary,
	geiger: SonificationPreset.Geiger,
	mechanical: SonificationPreset.Mechanical,
	synth: SonificationPreset.Synth,
	rain: SonificationPreset.Rain,
};

const NATIVE_VOICES: Record<SonificationLane, SonificationVoice> = {
	assistant: SonificationVoice.Assistant,
	thinking: SonificationVoice.Thinking,
	"tool-input": SonificationVoice.ToolInput,
	"tool-output": SonificationVoice.ToolOutput,
	"tool-success": SonificationVoice.ToolSuccess,
	"tool-error": SonificationVoice.ToolError,
};

const NATIVE_RATE_RESPONSES = {
	fixed: SonificationRateResponse.Fixed,
	subtle: SonificationRateResponse.Subtle,
	strong: SonificationRateResponse.Strong,
} as const;

const FIRST_BATCH_SPAN_MS = 24;
const MIN_BATCH_SPAN_MS = 4;
const MAX_BATCH_SPAN_MS = 250;
const ASCII_TOKEN_WEIGHT = 0.24;
const ASCII_PUNCTUATION_WEIGHT = 0.45;
const WHITESPACE_TOKEN_WEIGHT = 0.05;
const NON_ASCII_TOKEN_WEIGHT = 0.8;
const WORD_CHARACTER = /[\p{L}\p{N}\p{M}_]/u;
const MAX_TOOL_INPUT_PULSES_PER_BATCH = 64;
const MAX_TOOL_OUTPUT_PULSES_PER_BATCH = 24;
const TOOL_COMPLETION_PULSES = 2;
const TOOL_COMPLETION_SPAN_MS = 120;
const TOOL_COMPLETION_RATE = (TOOL_COMPLETION_PULSES * 1000) / TOOL_COMPLETION_SPAN_MS;
const AUDITION_GAP_MS = 350;

function unavailableStatus(error?: string): TokenAudioStatus {
	return {
		running: false,
		sampleRate: 0,
		channels: 0,
		error,
		acceptedBatches: 0,
		droppedCommandBatches: 0,
		droppedSchedulerBatches: 0,
		droppedPulses: 0,
		peakSchedulerOccupancy: 0,
	};
}

function createEstimatorState(): EstimatorState {
	return { estimatedTokenCredit: 0, insideWord: false, wordBlockId: undefined, lastDeltaAt: 0 };
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function isAsciiWordCode(code: number): boolean {
	return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
}

function isWhitespaceCode(code: number): boolean {
	return code === 9 || code === 10 || code === 13 || code === 32;
}

export function isSonificationPreset(value: string): value is SonificationPresetName {
	return SONIFICATION_PRESETS.includes(value as SonificationPresetName);
}

export class TokenSonifier {
	readonly #createEngine: () => TokenAudioEngine;
	#previewStopTimer: NodeJS.Timeout | undefined;
	readonly #auditionTimers = new Set<NodeJS.Timeout>();
	#engine: TokenAudioEngine | null = null;
	#running = false;
	readonly #estimators: Record<SonificationSource, EstimatorState> = {
		assistant: createEstimatorState(),
		thinking: createEstimatorState(),
		"tool-input": createEstimatorState(),
		"tool-output": createEstimatorState(),
	};
	readonly #toolOutputSnapshots = new Map<string, string>();
	#lastError: string | undefined;

	constructor(createEngine: () => TokenAudioEngine = () => new TokenAudioEngine()) {
		this.#createEngine = createEngine;
	}

	refresh(preview = false): TokenAudioStatus {
		if (!settings.get("sonification.enabled")) {
			this.stop();
			return this.status();
		}
		this.#cancelAuditionTimers();
		if (this.#previewStopTimer) {
			clearTimeout(this.#previewStopTimer);
			this.#previewStopTimer = undefined;
		}
		const status = this.#ensureStarted();
		if (status.running) {
			this.#engine?.configure(this.#config());
			if (preview) this.#engine?.preview(NATIVE_PRESETS[settings.get("sonification.preset")]);
		}
		return status;
	}

	preview(preset: SonificationPresetName = settings.get("sonification.preset")): TokenAudioStatus {
		this.#cancelAuditionTimers();
		if (this.#previewStopTimer) {
			clearTimeout(this.#previewStopTimer);
			this.#previewStopTimer = undefined;
		}
		const enabled = settings.get("sonification.enabled");
		const status = this.#ensureStarted();
		if (status.running) {
			const durationMs = this.#engine?.preview(NATIVE_PRESETS[preset]) ?? 0;
			if (!enabled) {
				clearTimeout(this.#previewStopTimer);
				this.#previewStopTimer = setTimeout(() => {
					this.#previewStopTimer = undefined;
					if (!settings.get("sonification.enabled")) this.stop();
				}, durationMs + 50);
				this.#previewStopTimer.unref();
			}
		}
		return status;
	}

	demo(preset: SonificationPresetName | "all" = settings.get("sonification.preset")): TokenAudioStatus {
		if (this.#previewStopTimer) {
			clearTimeout(this.#previewStopTimer);
			this.#previewStopTimer = undefined;
		}
		const enabled = settings.get("sonification.enabled");
		const status = this.#ensureStarted();
		if (!status.running || !this.#engine) return status;
		this.#cancelAuditionTimers();
		const presets = preset === "all" ? SONIFICATION_PRESETS : [preset];
		const durationMs = this.#engine.demo(NATIVE_PRESETS[presets[0]]);
		for (let index = 1; index < presets.length; index += 1) {
			const timer = setTimeout(
				() => {
					this.#auditionTimers.delete(timer);
					this.#engine?.demo(NATIVE_PRESETS[presets[index]]);
				},
				index * (durationMs + AUDITION_GAP_MS),
			);
			timer.unref();
			this.#auditionTimers.add(timer);
		}
		const totalDurationMs = presets.length * durationMs + (presets.length - 1) * AUDITION_GAP_MS;
		const finishTimer = setTimeout(() => {
			this.#auditionTimers.delete(finishTimer);
			if (settings.get("sonification.enabled")) {
				this.#engine?.configure(this.#config());
			} else if (!enabled) {
				this.stop();
			}
		}, totalDurationMs + 50);
		finishTimer.unref();
		this.#auditionTimers.add(finishTimer);
		return status;
	}

	pushDelta(text: string, source: SonificationSource, blockId: SonificationBlockId): void {
		if (!text || !isSettingsInitialized() || !settings.get("sonification.enabled") || !this.#accepts(source)) return;
		const estimator = this.#estimators[source];
		if (settings.get("sonification.granularity") === "word") this.#setWordBlock(estimator, blockId);
		const pulseCount = Math.min(this.#countPulses(text, estimator), this.#pulseLimit(source));
		if (pulseCount <= 0) return;

		const now = performance.now();
		const spanMs = estimator.lastDeltaAt
			? clamp(now - estimator.lastDeltaAt, MIN_BATCH_SPAN_MS, MAX_BATCH_SPAN_MS)
			: FIRST_BATCH_SPAN_MS;
		estimator.lastDeltaAt = now;
		this.#enqueuePulseBatch(pulseCount, spanMs, (pulseCount * 1000) / spanMs, source);
	}

	pushToolOutputSnapshot(toolCallId: string, text: string): void {
		if (!isSettingsInitialized() || !settings.get("sonification.enabled") || !this.#accepts("tool-output")) return;
		const previous = this.#toolOutputSnapshots.get(toolCallId) ?? "";
		this.#toolOutputSnapshots.set(toolCallId, text);
		if (text === previous) return;
		if (text.startsWith(previous)) {
			this.pushDelta(text.slice(previous.length), "tool-output", toolCallId);
		} else {
			this.#enqueuePulseBatch(1, FIRST_BATCH_SPAN_MS, 1_000 / FIRST_BATCH_SPAN_MS, "tool-output");
		}
	}

	finishToolOutput(toolCallId: string, text: string, isError: boolean): void {
		this.pushToolOutputSnapshot(toolCallId, text);
		this.#toolOutputSnapshots.delete(toolCallId);
		if (!isSettingsInitialized() || !settings.get("sonification.enabled") || !this.#accepts("tool-output")) return;
		this.#enqueuePulseBatch(
			TOOL_COMPLETION_PULSES,
			TOOL_COMPLETION_SPAN_MS,
			TOOL_COMPLETION_RATE,
			isError ? "tool-error" : "tool-success",
		);
	}

	clear(): void {
		this.#resetEstimator();
		this.#cancelAuditionTimers();
		this.#engine?.clear();
	}

	stop(): void {
		this.#resetEstimator();
		if (this.#previewStopTimer) {
			clearTimeout(this.#previewStopTimer);
			this.#previewStopTimer = undefined;
		}
		this.#cancelAuditionTimers();
		this.#engine?.stop();
		this.#running = false;
	}

	dispose(): void {
		this.stop();
		this.#engine = null;
	}

	status(): TokenAudioStatus {
		if (!this.#engine) return unavailableStatus(this.#lastError);
		return this.#engine.status();
	}

	#ensureStarted(): TokenAudioStatus {
		try {
			this.#engine ??= this.#createEngine();
			if (this.#running) {
				const current = this.#engine.status();
				if (current.running) return current;
				this.#running = false;
			}
			const status = this.#engine.start(this.#config());
			this.#running = status.running;
			this.#lastError = status.error;
			return status;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message !== this.#lastError) logger.debug("sonification: native audio unavailable", { error: message });
			this.#lastError = message;
			this.#running = false;
			return unavailableStatus(message);
		}
	}

	#config() {
		return {
			preset: NATIVE_PRESETS[settings.get("sonification.preset")],
			volume: clamp(settings.get("sonification.volume"), 0, 1),
			rateResponse: NATIVE_RATE_RESPONSES[settings.get("sonification.rateResponse")],
		};
	}

	#enqueuePulseBatch(count: number, spanMs: number, observedRate: number, lane: SonificationLane): void {
		const status = this.#ensureStarted();
		if (!status.running) return;
		this.#engine?.enqueuePulseBatch(count, spanMs, observedRate, NATIVE_VOICES[lane]);
	}

	#accepts(source: SonificationSource): boolean {
		const configured = settings.get("sonification.source");
		if (configured === "all") return true;
		if (configured === "tools") return source === "tool-input" || source === "tool-output";
		return configured === source;
	}

	#pulseLimit(source: SonificationSource): number {
		switch (source) {
			case "tool-input":
				return MAX_TOOL_INPUT_PULSES_PER_BATCH;
			case "tool-output":
				return MAX_TOOL_OUTPUT_PULSES_PER_BATCH;
			default:
				return Number.POSITIVE_INFINITY;
		}
	}

	#countPulses(text: string, estimator: EstimatorState): number {
		switch (settings.get("sonification.granularity")) {
			case "delta":
				return 1;
			case "word":
				return this.#countWords(text, estimator);
			case "estimated-token":
				return this.#countEstimatedTokens(text, estimator);
		}
	}

	#setWordBlock(estimator: EstimatorState, blockId: SonificationBlockId): void {
		if (blockId === estimator.wordBlockId) return;
		estimator.insideWord = false;
		estimator.wordBlockId = blockId;
	}

	#countWords(text: string, estimator: EstimatorState): number {
		let count = 0;
		for (const character of text) {
			const word = WORD_CHARACTER.test(character);
			if (word && !estimator.insideWord) count += 1;
			estimator.insideWord = word;
		}
		return count;
	}

	#countEstimatedTokens(text: string, estimator: EstimatorState): number {
		for (const character of text) {
			const code = character.codePointAt(0) ?? 0;
			if (isWhitespaceCode(code)) {
				estimator.estimatedTokenCredit += WHITESPACE_TOKEN_WEIGHT;
			} else if (isAsciiWordCode(code)) {
				estimator.estimatedTokenCredit += ASCII_TOKEN_WEIGHT;
			} else if (code <= 127) {
				estimator.estimatedTokenCredit += ASCII_PUNCTUATION_WEIGHT;
			} else {
				estimator.estimatedTokenCredit += NON_ASCII_TOKEN_WEIGHT;
			}
		}
		const pulses = Math.floor(estimator.estimatedTokenCredit);
		estimator.estimatedTokenCredit -= pulses;
		return pulses;
	}

	#cancelAuditionTimers(): void {
		for (const timer of this.#auditionTimers) clearTimeout(timer);
		this.#auditionTimers.clear();
	}

	#resetEstimator(): void {
		for (const estimator of Object.values(this.#estimators)) {
			estimator.estimatedTokenCredit = 0;
			estimator.insideWord = false;
			estimator.wordBlockId = undefined;
			estimator.lastDeltaAt = 0;
		}
		this.#toolOutputSnapshots.clear();
	}
}

export const tokenSonifier = new TokenSonifier();
