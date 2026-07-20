import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	SonificationPreset,
	SonificationVoice,
	type TokenAudioConfig,
	type TokenAudioEngine,
	type TokenAudioStatus,
} from "@oh-my-pi/pi-natives";
import { TokenSonifier } from "../../src/sonification";

type SonificationConfig = {
	"sonification.enabled": boolean;
	"sonification.granularity": "estimated-token" | "delta" | "word";
	"sonification.preset": "rotary" | "geiger" | "mechanical" | "synth" | "rain";
	"sonification.rateResponse": "fixed" | "subtle" | "strong";
	"sonification.source": "assistant" | "thinking" | "tools" | "all";
	"sonification.volume": number;
};

class FakeTokenAudioEngine {
	readonly batches: number[] = [];
	readonly voices: SonificationVoice[] = [];
	readonly demos: SonificationPreset[] = [];
	running = false;
	stopCount = 0;
	previewDurationMs = 5;
	demoDurationMs = 5;

	start(_config: TokenAudioConfig): TokenAudioStatus {
		this.running = true;
		return this.status();
	}

	configure(_config: TokenAudioConfig): void {}

	enqueuePulseBatch(count: number, _spanMs: number, _observedRate: number, voice: SonificationVoice): void {
		this.batches.push(count);
		this.voices.push(voice);
	}

	preview(_preset: SonificationPreset): number {
		return this.previewDurationMs;
	}

	demo(preset: SonificationPreset): number {
		this.demos.push(preset);
		return this.demoDurationMs;
	}

	clear(): void {}

	stop(): void {
		this.running = false;
		this.stopCount += 1;
	}

	status(): TokenAudioStatus {
		return {
			running: this.running,
			sampleRate: 48_000,
			channels: 2,
			acceptedBatches: this.batches.length,
			droppedCommandBatches: 0,
			droppedSchedulerBatches: 0,
			droppedPulses: 0,
			peakSchedulerOccupancy: 0,
		};
	}
}

function createHarness(overrides: Partial<SonificationConfig> = {}) {
	const config: SonificationConfig = {
		"sonification.enabled": true,
		"sonification.granularity": "estimated-token",
		"sonification.preset": "rotary",
		"sonification.rateResponse": "subtle",
		"sonification.source": "assistant",
		"sonification.volume": 0.15,
		...overrides,
	};
	settings.set("sonification.enabled", config["sonification.enabled"]);
	settings.set("sonification.granularity", config["sonification.granularity"]);
	settings.set("sonification.preset", config["sonification.preset"]);
	settings.set("sonification.rateResponse", config["sonification.rateResponse"]);
	settings.set("sonification.source", config["sonification.source"]);
	settings.set("sonification.volume", config["sonification.volume"]);
	const engine = new FakeTokenAudioEngine();
	const sonifier = new TokenSonifier(() => engine as TokenAudioEngine);
	return { engine, sonifier };
}

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	vi.useRealTimers();
	resetSettingsForTest();
});

describe("token sonification mapping", () => {
	it("carries estimated-token fractions across provider deltas", () => {
		const { engine, sonifier } = createHarness();
		sonifier.pushDelta("abcd", "assistant", 0);
		expect(engine.batches).toEqual([]);
		sonifier.pushDelta("e", "assistant", 0);
		expect(engine.batches).toEqual([1]);
	});

	it("keeps fractional token estimates independent across stream sources", () => {
		const { engine, sonifier } = createHarness({ "sonification.source": "all" });
		sonifier.pushDelta("abcd", "assistant", 0);
		sonifier.pushDelta("e", "thinking", 0);
		expect(engine.batches).toEqual([]);
		sonifier.pushDelta("e", "assistant", 0);
		expect(engine.batches).toEqual([1]);
	});

	it("counts Unicode words across split deltas without treating punctuation or emoji as words", () => {
		const { engine, sonifier } = createHarness({ "sonification.granularity": "word" });
		sonifier.pushDelta("hel", "assistant", 0);
		sonifier.pushDelta("lo", "assistant", 0);
		sonifier.pushDelta("—world", "assistant", 0);
		sonifier.pushDelta("🙂again", "assistant", 0);
		sonifier.pushDelta(" café", "assistant", 0);
		expect(engine.batches).toEqual([1, 1, 1, 1]);
	});

	it("starts a new word at each accepted source or content-block boundary", () => {
		const { engine, sonifier } = createHarness({
			"sonification.granularity": "word",
			"sonification.source": "all",
		});
		sonifier.pushDelta("thought", "thinking", 0);
		sonifier.pushDelta("answer", "assistant", 1);
		sonifier.pushDelta("first", "assistant", 2);
		sonifier.pushDelta("second", "assistant", 4);
		expect(engine.batches).toEqual([1, 1, 1, 1]);
	});

	it("maps each accepted provider delta to one pulse and filters rejected sources", () => {
		const { engine, sonifier } = createHarness({ "sonification.granularity": "delta" });
		sonifier.pushDelta("hidden reasoning", "thinking", 0);
		sonifier.pushDelta("visible answer", "assistant", 1);
		expect(engine.batches).toEqual([1]);
	});

	it("uses a bounded bright voice for streamed tool-call arguments", () => {
		const { engine, sonifier } = createHarness({ "sonification.source": "tools" });
		sonifier.pushDelta("a".repeat(1_000), "tool-input", 0);
		expect(engine.batches).toEqual([64]);
		expect(engine.voices).toEqual([SonificationVoice.ToolInput]);
	});

	it("sonifies only tool-output growth and ends with distinct success or failure accents", () => {
		const { engine, sonifier } = createHarness({
			"sonification.granularity": "delta",
			"sonification.source": "tools",
		});
		sonifier.pushToolOutputSnapshot("call-1", "progress 1");
		sonifier.pushToolOutputSnapshot("call-1", "progress 1");
		sonifier.pushToolOutputSnapshot("call-1", "progress 2");
		sonifier.pushToolOutputSnapshot("call-1", "progress 2 done");
		sonifier.finishToolOutput("call-1", "progress 2 done", false);
		sonifier.finishToolOutput("call-2", "failed", true);

		expect(engine.batches).toEqual([1, 1, 1, 2, 1, 2]);
		expect(engine.voices).toEqual([
			SonificationVoice.ToolOutput,
			SonificationVoice.ToolOutput,
			SonificationVoice.ToolOutput,
			SonificationVoice.ToolSuccess,
			SonificationVoice.ToolOutput,
			SonificationVoice.ToolError,
		]);
	});
	it("releases a preview-only output stream after its scheduled audio completes", () => {
		vi.useFakeTimers();
		const { engine, sonifier } = createHarness({ "sonification.enabled": false });
		sonifier.preview("geiger");
		expect(engine.running).toBe(true);
		vi.advanceTimersByTime(engine.previewDurationMs + 50);
		expect(engine.running).toBe(false);
		expect(engine.stopCount).toBe(1);
	});

	it("auditions every preset deterministically and releases a temporary output stream", () => {
		vi.useFakeTimers();
		const { engine, sonifier } = createHarness({ "sonification.enabled": false });
		sonifier.demo("all");
		expect(engine.demos).toEqual([SonificationPreset.Rotary]);

		vi.advanceTimersByTime((engine.demoDurationMs + 350) * 4);
		expect(engine.demos).toEqual([
			SonificationPreset.Rotary,
			SonificationPreset.Geiger,
			SonificationPreset.Mechanical,
			SonificationPreset.Synth,
			SonificationPreset.Rain,
		]);

		vi.advanceTimersByTime(engine.demoDurationMs + 50);
		expect(engine.running).toBe(false);
		expect(engine.stopCount).toBe(1);
	});
});
