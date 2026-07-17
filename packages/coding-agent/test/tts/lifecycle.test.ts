import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { RefCountedWorkerHandle } from "@oh-my-pi/pi-coding-agent/subprocess/worker-client";
import type { SpeechEnhancer } from "@oh-my-pi/pi-coding-agent/tts/speech-enhancer";
import {
	type TtsAudioChunk,
	TtsClient,
	type TtsStreamHandle,
	ttsClient,
} from "@oh-my-pi/pi-coding-agent/tts/tts-client";
import type { TtsWorkerInbound, TtsWorkerOutbound } from "@oh-my-pi/pi-coding-agent/tts/tts-protocol";
import { Vocalizer, type VocalizerPlayer } from "@oh-my-pi/pi-coding-agent/tts/vocalizer";

const MODEL = "kokoro" as const;

type MessageHandler = (message: TtsWorkerOutbound) => void;
type ErrorHandler = (error: Error) => void;

class FakeWorker implements RefCountedWorkerHandle<TtsWorkerInbound, TtsWorkerOutbound> {
	readonly sent: TtsWorkerInbound[] = [];
	refCount = 0;
	unrefCount = 0;
	terminateCount = 0;
	autoCompleteSynthesis = false;
	#parkedStreams = new Set<string>();
	#waitingSynthesis: Array<Extract<TtsWorkerInbound, { type: "synthesize" }>> = [];
	throwOn: TtsWorkerInbound["type"] | null = null;
	#messages = new Set<MessageHandler>();
	#errors = new Set<ErrorHandler>();

	send(message: TtsWorkerInbound): void {
		this.sent.push(message);
		if (message.type === this.throwOn) throw new Error(`fake ${message.type} failed`);
		if (message.type === "stream-start") {
			this.#parkedStreams.add(message.id);
			return;
		}
		if (message.type === "stream-cancel") {
			this.#parkedStreams.delete(message.id);
			this.#flushWaitingSynthesis();
			return;
		}
		if (message.type === "synthesize" && this.autoCompleteSynthesis) {
			if (this.#parkedStreams.size > 0) this.#waitingSynthesis.push(message);
			else this.#emitSynthesis(message);
		}
	}

	#emitSynthesis(message: Extract<TtsWorkerInbound, { type: "synthesize" }>): void {
		queueMicrotask(() =>
			this.emit({ type: "audio", id: message.id, pcm: new Float32Array([1]), sampleRate: 24_000 }),
		);
	}

	#flushWaitingSynthesis(): void {
		if (this.#parkedStreams.size > 0) return;
		const waiting = this.#waitingSynthesis.splice(0);
		for (const message of waiting) this.#emitSynthesis(message);
	}

	onMessage(handler: MessageHandler): () => void {
		this.#messages.add(handler);
		return () => this.#messages.delete(handler);
	}

	onError(handler: ErrorHandler): () => void {
		this.#errors.add(handler);
		return () => this.#errors.delete(handler);
	}

	async terminate(): Promise<void> {
		this.terminateCount++;
	}

	ref(): void {
		this.refCount++;
	}

	unref(): void {
		this.unrefCount++;
	}

	emit(message: TtsWorkerOutbound): void {
		for (const handler of this.#messages) handler(message);
	}

	fail(error: Error): void {
		for (const handler of this.#errors) handler(error);
	}

	streamId(): string {
		const start = this.sent.find(message => message.type === "stream-start");
		if (start?.type !== "stream-start") throw new Error("stream did not start");
		return start.id;
	}
}

class FakePlayer implements VocalizerPlayer {
	starts: number[] = [];
	writes: Float32Array[] = [];
	gains: number[] = [];
	endCount = 0;
	stopCount = 0;

	start(sampleRate: number): void {
		this.starts.push(sampleRate);
	}

	write(pcm: Float32Array): void {
		this.writes.push(pcm);
	}

	setGain(gain: number): void {
		this.gains.push(gain);
	}

	async end(): Promise<void> {
		this.endCount++;
	}

	stop(): void {
		this.stopCount++;
	}
}

async function drainMicrotasks(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

function streamHandle(pushes: string[], ended: { value: boolean }): TtsStreamHandle {
	return {
		push(text) {
			pushes.push(text);
		},
		end() {
			ended.value = true;
		},
		chunks: (async function* () {})(),
	};
}

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({
		inMemory: true,
		overrides: {
			"speech.enabled": true,
			"speech.enhanced": false,
			"speech.voice": "af_alloy",
			"tts.localModel": MODEL,
		},
	});
});
async function enableEnhanced(): Promise<void> {
	resetSettingsForTest();
	await Settings.init({
		inMemory: true,
		overrides: {
			"speech.enabled": true,
			"speech.enhanced": true,
			"speech.voice": "af_alloy",
			"tts.localModel": MODEL,
		},
	});
}

afterEach(() => {
	vi.restoreAllMocks();
	resetSettingsForTest();
});

describe("TtsClient fake worker lifecycle", () => {
	it("preserves buffered chunk order and refs only while a stream is pending", async () => {
		const worker = new FakeWorker();
		const client = new TtsClient(() => worker);
		const handle = client.synthesizeStream(MODEL);
		handle.push("one");
		handle.push("two");
		handle.end();
		const id = worker.streamId();
		worker.emit({ type: "audio-chunk", id, index: 1, text: "two", pcm: new Float32Array([2]), sampleRate: 24_000 });
		worker.emit({ type: "audio-chunk", id, index: 0, text: "one", pcm: new Float32Array([1]), sampleRate: 24_000 });
		worker.emit({ type: "stream-done", id });

		const chunks: TtsAudioChunk[] = [];
		for await (const chunk of handle.chunks) chunks.push(chunk);
		expect(chunks.map(chunk => chunk.text)).toEqual(["two", "one"]);
		expect(worker.refCount).toBe(1);
		expect(worker.unrefCount).toBe(1);
		expect(worker.sent.map(message => message.type)).toEqual([
			"stream-start",
			"stream-push",
			"stream-push",
			"stream-end",
		]);
	});

	it("propagates worker stream errors and releases the process reference", async () => {
		const worker = new FakeWorker();
		const client = new TtsClient(() => worker);
		const handle = client.synthesizeStream(MODEL);
		const next = handle.chunks.next();
		worker.emit({ type: "error", id: worker.streamId(), error: "synthesis exploded" });

		await expect(next).rejects.toThrow("synthesis exploded");
		expect(worker.refCount).toBe(1);
		expect(worker.unrefCount).toBe(1);
		expect(worker.terminateCount).toBe(1);
	});

	it("settles the stream when a send fails instead of leaking a pending request", async () => {
		const worker = new FakeWorker();
		worker.throwOn = "stream-start";
		const client = new TtsClient(() => worker);
		const handle = client.synthesizeStream(MODEL);

		await expect(handle.chunks.next()).rejects.toThrow("fake stream-start failed");
		expect(worker.refCount).toBe(1);
		expect(worker.unrefCount).toBe(1);
	});

	it("fails a stream when a non-stream response uses its request id", async () => {
		const worker = new FakeWorker();
		const client = new TtsClient(() => worker);
		const handle = client.synthesizeStream(MODEL);
		const next = handle.chunks.next();
		worker.emit({ type: "audio", id: worker.streamId(), pcm: new Float32Array([1]), sampleRate: 24_000 });

		await expect(next).rejects.toThrow("returned audio for stream request");
		expect(worker.unrefCount).toBe(1);
	});

	it("cancels a mismatched stream session before servicing later synthesis", async () => {
		const worker = new FakeWorker();
		worker.autoCompleteSynthesis = true;
		const client = new TtsClient(() => worker);
		const handle = client.synthesizeStream(MODEL);
		const next = handle.chunks.next();
		worker.emit({ type: "audio", id: worker.streamId(), pcm: new Float32Array([1]), sampleRate: 24_000 });

		await expect(next).rejects.toThrow("returned audio for stream request");
		expect(worker.sent.map(message => message.type)).toContain("stream-cancel");

		const audio = await client.synthesize(MODEL, "later");
		expect(audio?.sampleRate).toBe(24_000);
		expect(audio?.pcm).toEqual(new Float32Array([1]));
	});

	it("settles a synthesis request when a stream response uses its request id", async () => {
		const worker = new FakeWorker();
		const client = new TtsClient(() => worker);
		const pending = client.synthesize(MODEL, "hello");
		const request = worker.sent.find(message => message.type === "synthesize");
		if (request?.type !== "synthesize") throw new Error("synthesis did not start");
		worker.emit({ type: "stream-done", id: request.id });

		await expect(pending).resolves.toBeNull();
		expect(worker.unrefCount).toBe(1);
	});

	it("aborts a stream with a cancel message and closes its iterator", async () => {
		const worker = new FakeWorker();
		const client = new TtsClient(() => worker);
		const controller = new AbortController();
		const handle = client.synthesizeStream(MODEL, { signal: controller.signal });
		controller.abort();

		await expect(handle.chunks.next()).resolves.toEqual({ value: undefined, done: true });
		expect(worker.sent.map(message => message.type)).toContain("stream-cancel");
		expect(worker.unrefCount).toBe(1);
	});

	it("disposes in-flight streams and terminates the worker without waiting for audio", async () => {
		const worker = new FakeWorker();
		const client = new TtsClient(() => worker);
		const handle = client.synthesizeStream(MODEL);
		const next = handle.chunks.next();
		await client.terminate();

		await expect(next).resolves.toEqual({ value: undefined, done: true });
		expect(worker.unrefCount).toBe(1);
		expect(worker.terminateCount).toBe(1);
	});
});

describe("Vocalizer fake player lifecycle", () => {
	it("flushes an idle partial deterministically without opening audio early", async () => {
		vi.useFakeTimers();
		try {
			const pushes: string[] = [];
			const ended = { value: false };
			const player = new FakePlayer();
			const synthesize = vi
				.spyOn(ttsClient, "synthesizeStream")
				.mockImplementation(() => streamHandle(pushes, ended));
			const vocalizer = new Vocalizer(() => player);

			vocalizer.pushDelta("hello while generation is paused");
			expect(synthesize).not.toHaveBeenCalled();
			vi.advanceTimersByTime(999);
			expect(synthesize).not.toHaveBeenCalled();
			vi.advanceTimersByTime(1);
			await drainMicrotasks();

			expect(synthesize).toHaveBeenCalledTimes(1);
			expect(pushes).toEqual(["hello while generation is paused"]);
			vocalizer.flush();
			expect(ended.value).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps enhanced rewrites in source order even when later work resolves first", async () => {
		await enableEnhanced();
		const ended = { value: false };
		const pushes: string[] = [];
		const player = new FakePlayer();
		vi.spyOn(ttsClient, "synthesizeStream").mockImplementation(() => streamHandle(pushes, ended));
		const vocalizer = new Vocalizer(() => player);
		const rewrites: Array<{ resolve: (value: string) => void; reject: (error: Error) => void }> = [];
		vocalizer.setEnhancer({
			rewrite: () => {
				const deferred = Promise.withResolvers<string>();
				rewrites.push(deferred);
				return deferred.promise;
			},
		} as unknown as SpeechEnhancer);

		vocalizer.pushDelta(`first sentence.\n\n${"x".repeat(400)}.\n\n`);
		await drainMicrotasks();
		expect(rewrites).toHaveLength(2);
		rewrites[1]!.resolve("second spoken.");
		await drainMicrotasks();
		expect(pushes).toEqual([]);
		rewrites[0]!.resolve("first spoken.");
		vocalizer.flush();
		await drainMicrotasks();

		expect(pushes).toEqual(["first spoken.", "second spoken."]);
		expect(ended.value).toBe(true);
	});

	it("falls back to mechanical cleanup when a rewrite rejects", async () => {
		await enableEnhanced();
		const pushes: string[] = [];
		const ended = { value: false };
		vi.spyOn(ttsClient, "synthesizeStream").mockImplementation(() => streamHandle(pushes, ended));
		const vocalizer = new Vocalizer(() => new FakePlayer());
		vocalizer.setEnhancer({
			rewrite: async () => {
				throw new Error("rewriter unavailable");
			},
		} as unknown as SpeechEnhancer);

		vocalizer.pushDelta("raw sentence.");
		vocalizer.flush();
		await drainMicrotasks();

		expect(pushes).toEqual(["raw sentence."]);
	});
	it("clear aborts synthesis and stops the live player during playback", async () => {
		const player = new FakePlayer();
		const pushes: string[] = [];
		const ended = { value: false };
		let signal: AbortSignal | undefined;
		const stream: TtsStreamHandle = {
			...streamHandle(pushes, ended),
			chunks: (async function* () {
				await new Promise<void>(() => {});
			})(),
		};
		vi.spyOn(ttsClient, "synthesizeStream").mockImplementation((_model, options) => {
			signal = options?.signal;
			return stream;
		});
		const vocalizer = new Vocalizer(() => player);
		vocalizer.pushDelta("speak now.\n");
		vocalizer.flush();
		await drainMicrotasks();
		vocalizer.clear();

		expect(signal?.aborted).toBe(true);
		expect(player.stopCount).toBe(1);
	});
});
