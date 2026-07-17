import { logger } from "@oh-my-pi/pi-utils";
import {
	createUnavailableWorker,
	createWorkerHandle,
	createWorkerSubprocess,
	logWorkerMessage,
	type RefCountedWorkerHandle,
	resolveWorkerSpawnCmd,
	SMOKE_TEST_TIMEOUT_MS,
	type SpawnedSubprocess,
	smokeTestWorker,
	spawnWorkerOrUnavailable,
} from "../subprocess/worker-client";
import { tinyWorkerEnv } from "../tiny/title-client";
import { safeSend } from "../utils/ipc";
import { isTtsLocalModelKey, type TtsLocalModelKey } from "./models";
import type { TtsProgressEvent, TtsWorkerInbound, TtsWorkerOutbound } from "./tts-protocol";

/** Decoded PCM returned by a local synthesis request. */
export interface TtsAudio {
	pcm: Float32Array;
	sampleRate: number;
}

type PendingRequest =
	| { kind: "synthesize"; modelKey: TtsLocalModelKey; resolve: (audio: TtsAudio | null) => void }
	| { kind: "download"; modelKey: TtsLocalModelKey; resolve: (ok: boolean) => void }
	| { kind: "stream"; modelKey: TtsLocalModelKey; channel: AudioChunkChannel };

export interface TtsSynthesizeOptions {
	voice?: string;
	signal?: AbortSignal;
}

export interface TtsDownloadOptions {
	signal?: AbortSignal;
	onProgress?: (event: TtsProgressEvent) => void;
}

export interface TtsStreamOptions {
	voice?: string;
	signal?: AbortSignal;
}

/** One synthesized segment of a streaming session, in emission order. */
export interface TtsAudioChunk {
	index: number;
	text: string;
	pcm: Float32Array;
	sampleRate: number;
}

/**
 * A live streaming-synthesis session. Feed complete speakable segments with
 * {@link push} (the worker synthesizes each push as-is) and close the input
 * with {@link end}; `chunks` yields each segment's audio as soon as it is
 * ready, then completes once the worker finishes draining the closed input.
 */
export interface TtsStreamHandle {
	push(text: string): void;
	end(): void;
	chunks: AsyncIterableIterator<TtsAudioChunk>;
}

/**
 * Single-producer/single-consumer async queue bridging the worker's IPC
 * `audio-chunk` messages to an async iterator. Chunks pushed while no consumer
 * is awaiting are buffered in order; {@link close} ends the iterator and
 * {@link fail} surfaces an error to the awaiting (or next) consumer.
 */
class AudioChunkChannel {
	#queue: TtsAudioChunk[] = [];
	#waiters: Array<{
		resolve: (result: IteratorResult<TtsAudioChunk>) => void;
		reject: (error: Error) => void;
	}> = [];
	#error: Error | null = null;
	#settled = false;
	#onSettle: (() => void) | undefined;

	constructor(onSettle?: () => void) {
		this.#onSettle = onSettle;
	}

	push(chunk: TtsAudioChunk): void {
		if (this.#settled) return;
		const waiter = this.#waiters.shift();
		if (waiter) waiter.resolve({ value: chunk, done: false });
		else this.#queue.push(chunk);
	}

	close(): void {
		this.#settle(null);
	}

	fail(error: Error): void {
		this.#settle(error);
	}

	#settle(error: Error | null): void {
		if (this.#settled) return;
		this.#settled = true;
		this.#error = error;
		for (const waiter of this.#waiters) {
			if (error) waiter.reject(error);
			else waiter.resolve({ value: undefined, done: true });
		}
		this.#waiters = [];
		this.#onSettle?.();
	}

	async *iterator(): AsyncIterableIterator<TtsAudioChunk> {
		while (true) {
			const buffered = this.#queue.shift();
			if (buffered) {
				yield buffered;
				continue;
			}
			if (this.#error) throw this.#error;
			if (this.#settled) return;
			const { promise, resolve, reject } = Promise.withResolvers<IteratorResult<TtsAudioChunk>>();
			this.#waiters.push({ resolve, reject });
			const result = await promise;
			if (result.done) return;
			yield result.value;
		}
	}
}

/**
 * Hidden subcommand on the main CLI that boots the TTS worker in the spawned
 * subprocess. Kept in sync with the dispatch in `cli.ts` (Main-owned).
 */
export const TTS_WORKER_ARG = "__omp_worker_tts";

/**
 * Spawn the TTS worker as a subprocess. Exported for tests and the smoke probe;
 * production callers go through {@link spawnTtsWorker}.
 */
export function createTtsSubprocess(): SpawnedSubprocess<TtsWorkerOutbound> {
	return createWorkerSubprocess<TtsWorkerOutbound>({
		spawnCommand: resolveWorkerSpawnCmd(TTS_WORKER_ARG),
		env: tinyWorkerEnv(),
		exitLabel: "tts subprocess",
	});
}

function wrapSubprocess(
	spawned: SpawnedSubprocess<TtsWorkerOutbound>,
): RefCountedWorkerHandle<TtsWorkerInbound, TtsWorkerOutbound> {
	const { proc } = spawned;
	return {
		...createWorkerHandle<TtsWorkerInbound, TtsWorkerOutbound>(spawned, message => safeSend(proc, message, "tts")),
		ref() {
			try {
				proc.ref();
			} catch {
				// Already gone.
			}
		},
		unref() {
			try {
				proc.unref();
			} catch {
				// Already gone.
			}
		},
	};
}

function spawnInlineUnavailableWorker(error: unknown): RefCountedWorkerHandle<TtsWorkerInbound, TtsWorkerOutbound> {
	return {
		...createUnavailableWorker<TtsWorkerInbound, TtsWorkerOutbound>(error),
		ref() {},
		unref() {},
	};
}

function spawnTtsWorker(): RefCountedWorkerHandle<TtsWorkerInbound, TtsWorkerOutbound> {
	return spawnWorkerOrUnavailable(
		() => wrapSubprocess(createTtsSubprocess()),
		spawnInlineUnavailableWorker,
		"TTS worker spawn failed; local TTS disabled",
	);
}

export class TtsClient {
	#worker: RefCountedWorkerHandle<TtsWorkerInbound, TtsWorkerOutbound> | null = null;
	#unsubscribeMessage: (() => void) | null = null;
	#unsubscribeError: (() => void) | null = null;
	#pending = new Map<string, PendingRequest>();
	#progressListeners = new Set<(event: TtsProgressEvent) => void>();
	#nextRequestId = 0;
	#refed = false;
	#spawnWorker: () => RefCountedWorkerHandle<TtsWorkerInbound, TtsWorkerOutbound>;

	constructor(spawnWorker: () => RefCountedWorkerHandle<TtsWorkerInbound, TtsWorkerOutbound> = spawnTtsWorker) {
		this.#spawnWorker = spawnWorker;
	}

	onProgress(listener: (event: TtsProgressEvent) => void): () => void {
		this.#progressListeners.add(listener);
		return () => this.#progressListeners.delete(listener);
	}

	async synthesize(modelKey: string, text: string, options: TtsSynthesizeOptions = {}): Promise<TtsAudio | null> {
		if (!isTtsLocalModelKey(modelKey)) return null;
		if (options.signal?.aborted) return null;

		try {
			const worker = this.#ensureWorker();
			const id = String(++this.#nextRequestId);
			const { promise, resolve } = Promise.withResolvers<TtsAudio | null>();
			this.#addPending(id, { kind: "synthesize", modelKey, resolve });
			const abort = (): void => {
				const pending = this.#pending.get(id);
				if (pending?.kind !== "synthesize") return;
				this.#deletePending(id);
				pending.resolve(null);
			};
			options.signal?.addEventListener("abort", abort, { once: true });
			try {
				const request: TtsWorkerInbound = options.voice
					? { type: "synthesize", id, modelKey, text, voice: options.voice }
					: { type: "synthesize", id, modelKey, text };
				worker.send(request);
				return await promise;
			} finally {
				options.signal?.removeEventListener("abort", abort);
				this.#deletePending(id);
			}
		} catch (error) {
			logger.debug("tts: local synthesis failed", {
				modelKey,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	}

	/**
	 * Open a streaming-synthesis session. Complete speakable segments are fed
	 * through the returned handle's `push`/`end`; audio is emitted one segment
	 * at a time via `chunks`, so playback can begin before the full text is
	 * known. Returns an inert handle (immediately-ended `chunks`) for unknown
	 * models or an already-aborted signal, and fails the iterator if the worker
	 * cannot spawn.
	 */
	synthesizeStream(modelKey: string, options: TtsStreamOptions = {}): TtsStreamHandle {
		if (!isTtsLocalModelKey(modelKey) || options.signal?.aborted) {
			const channel = new AudioChunkChannel();
			channel.close();
			return { push: () => {}, end: () => {}, chunks: channel.iterator() };
		}

		let worker: RefCountedWorkerHandle<TtsWorkerInbound, TtsWorkerOutbound>;
		try {
			worker = this.#ensureWorker();
		} catch (error) {
			logger.debug("tts: stream synthesis failed to start", {
				modelKey,
				error: error instanceof Error ? error.message : String(error),
			});
			const channel = new AudioChunkChannel();
			channel.fail(error instanceof Error ? error : new Error(String(error)));
			return { push: () => {}, end: () => {}, chunks: channel.iterator() };
		}

		const id = String(++this.#nextRequestId);
		const signal = options.signal;
		let closed = false;
		let ended = false;
		const abort = (): void => {
			if (closed) return;
			closed = true;
			ended = true;
			if (this.#pending.has(id)) {
				this.#deletePending(id);
				try {
					worker.send({ type: "stream-cancel", id });
				} catch {
					// The worker may already be gone; the channel still must settle.
				}
			}
			channel.close();
		};
		const channel = new AudioChunkChannel(() => signal?.removeEventListener("abort", abort));
		const fail = (error: unknown): void => {
			if (closed) return;
			closed = true;
			ended = true;
			this.#deletePending(id);
			channel.fail(error instanceof Error ? error : new Error(String(error)));
		};
		this.#addPending(id, { kind: "stream", modelKey, channel });
		signal?.addEventListener("abort", abort, { once: true });

		const start: TtsWorkerInbound = options.voice
			? { type: "stream-start", id, modelKey, voice: options.voice }
			: { type: "stream-start", id, modelKey };
		try {
			worker.send(start);
		} catch (error) {
			fail(error);
		}

		return {
			push: (text: string) => {
				if (closed || ended) return;
				try {
					worker.send({ type: "stream-push", id, text });
				} catch (error) {
					fail(error);
				}
			},
			end: () => {
				if (closed || ended) return;
				ended = true;
				try {
					worker.send({ type: "stream-end", id });
				} catch (error) {
					fail(error);
				}
			},
			chunks: channel.iterator(),
		};
	}

	async downloadModel(modelKey: string, options: TtsDownloadOptions = {}): Promise<boolean> {
		if (!isTtsLocalModelKey(modelKey)) return false;
		if (options.signal?.aborted) return false;

		const unsubscribe = options.onProgress ? this.onProgress(options.onProgress) : undefined;
		try {
			const worker = this.#ensureWorker();
			const id = String(++this.#nextRequestId);
			const { promise, resolve } = Promise.withResolvers<boolean>();
			this.#addPending(id, { kind: "download", modelKey, resolve });
			const abort = (): void => {
				const pending = this.#pending.get(id);
				if (pending?.kind !== "download") return;
				this.#deletePending(id);
				pending.resolve(false);
			};
			options.signal?.addEventListener("abort", abort, { once: true });
			try {
				worker.send({ type: "download", id, modelKey });
				return await promise;
			} finally {
				options.signal?.removeEventListener("abort", abort);
				this.#deletePending(id);
			}
		} catch (error) {
			logger.debug("tts: local model download failed", {
				modelKey,
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		} finally {
			unsubscribe?.();
		}
	}

	async terminate(): Promise<void> {
		const worker = this.#worker;
		this.#worker = null;
		this.#unsubscribeMessage?.();
		this.#unsubscribeMessage = null;
		this.#unsubscribeError?.();
		this.#unsubscribeError = null;
		for (const pending of this.#pending.values()) {
			this.#emitProgress({ modelKey: pending.modelKey, status: "error" });
			if (pending.kind === "synthesize") pending.resolve(null);
			else if (pending.kind === "download") pending.resolve(false);
			else pending.channel.close();
		}
		this.#pending.clear();
		if (this.#refed) worker?.unref();
		this.#refed = false;
		try {
			await worker?.terminate();
		} catch {
			// Already gone.
		}
	}

	#ensureWorker(): RefCountedWorkerHandle<TtsWorkerInbound, TtsWorkerOutbound> {
		if (this.#worker) return this.#worker;
		const worker = this.#spawnWorker();
		this.#worker = worker;
		this.#unsubscribeMessage = worker.onMessage(message => this.#handleMessage(message));
		this.#unsubscribeError = worker.onError(error => this.#handleWorkerError(error));
		return worker;
	}

	/** Register a pending request and keep the worker referenced while work is in flight. */
	#addPending(id: string, request: PendingRequest): void {
		this.#pending.set(id, request);
		this.#syncWorkerRef();
	}

	/** Drop a pending request and unref the worker once nothing is in flight. */
	#deletePending(id: string): void {
		if (this.#pending.delete(id)) this.#syncWorkerRef();
	}

	/**
	 * The TTS subprocess is spawned `unref`'d so an idle worker never blocks
	 * process exit. A short-lived CLI command (`omp say`) awaiting a request would
	 * otherwise let the event loop drain and exit before the audio arrives, so we
	 * `ref` the worker exactly while at least one request is pending.
	 */
	#syncWorkerRef(): void {
		const worker = this.#worker;
		if (!worker) return;
		const shouldRef = this.#pending.size > 0;
		if (shouldRef === this.#refed) return;
		this.#refed = shouldRef;
		if (shouldRef) worker.ref();
		else worker.unref();
	}

	#handleMessage(message: TtsWorkerOutbound): void {
		if (message.type === "log") {
			logWorkerMessage(message);
			return;
		}
		if (message.type === "progress") {
			this.#emitProgress(message.event);
			return;
		}
		if (message.type === "pong") return;

		const pending = this.#pending.get(message.id);
		if (!pending) return;

		// Streaming chunks are non-terminal: keep the session registered until
		// `stream-done` (or an error) so later chunks still route to its channel.
		if (message.type === "audio-chunk") {
			if (pending.kind === "stream") {
				pending.channel.push({
					index: message.index,
					text: message.text,
					pcm: message.pcm,
					sampleRate: message.sampleRate,
				});
			} else {
				this.#failKindMismatch(message.id, pending, message.type);
			}
			return;
		}

		if (message.type === "stream-done") {
			if (pending.kind === "stream") {
				this.#deletePending(message.id);
				pending.channel.close();
			} else this.#failKindMismatch(message.id, pending, message.type);
			return;
		}
		if (message.type === "audio") {
			if (pending.kind === "synthesize") {
				this.#deletePending(message.id);
				pending.resolve({ pcm: message.pcm, sampleRate: message.sampleRate });
			} else this.#failKindMismatch(message.id, pending, message.type);
			return;
		}
		if (message.type === "downloaded") {
			if (pending.kind === "download") {
				this.#deletePending(message.id);
				pending.resolve(true);
			} else this.#failKindMismatch(message.id, pending, message.type);
			return;
		}
		this.#deletePending(message.id);
		logger.debug("tts: worker returned error", { error: message.error });
		this.#emitProgress({ modelKey: pending.modelKey, status: "error" });
		if (pending.kind === "synthesize") pending.resolve(null);
		else if (pending.kind === "download") pending.resolve(false);
		else pending.channel.fail(new Error(message.error));
		void this.terminate();
	}

	#failKindMismatch(id: string, pending: PendingRequest, responseType: string): void {
		const error = new Error(`tts worker returned ${responseType} for ${pending.kind} request`);
		logger.warn("tts: worker response kind mismatch", { responseType, requestKind: pending.kind });
		let cancellationFailed = false;
		try {
			// A mismatched response can come from a stream session that is parked
			// on the worker's serialized queue. Cancel that exact session while
			// the request still keeps the worker referenced, before reusing it.
			this.#worker?.send({ type: "stream-cancel", id });
		} catch (cancelError) {
			// A failed cancellation means this transport cannot be trusted for
			// reuse; terminate it so a parked stream cannot block the queue.
			cancellationFailed = true;
			logger.warn("tts: failed to cancel mismatched worker stream", {
				error: cancelError instanceof Error ? cancelError.message : String(cancelError),
			});
		}
		this.#deletePending(id);
		this.#emitProgress({ modelKey: pending.modelKey, status: "error" });
		if (pending.kind === "synthesize") pending.resolve(null);
		else if (pending.kind === "download") pending.resolve(false);
		else pending.channel.fail(error);
		if (cancellationFailed) void this.terminate();
	}

	#emitProgress(event: TtsProgressEvent): void {
		for (const listener of this.#progressListeners) listener(event);
	}

	#handleWorkerError(error: Error): void {
		logger.warn("tts: worker error", { error: error.message });
		for (const pending of this.#pending.values()) {
			this.#emitProgress({ modelKey: pending.modelKey, status: "error" });
			if (pending.kind === "synthesize") pending.resolve(null);
			else if (pending.kind === "download") pending.resolve(false);
			else pending.channel.fail(error);
		}
		this.#pending.clear();
		void this.terminate();
	}
}

export const ttsClient = new TtsClient();

export async function shutdownTtsClient(): Promise<void> {
	await ttsClient.terminate();
}

export async function smokeTestTtsWorker({
	timeoutMs = SMOKE_TEST_TIMEOUT_MS,
}: {
	timeoutMs?: number;
} = {}): Promise<void> {
	await smokeTestWorker(wrapSubprocess(createTtsSubprocess()), "tts worker", timeoutMs);
}
