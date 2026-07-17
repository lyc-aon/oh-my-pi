import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { entryId, hostId, projectId, type ServerFrame, sessionId } from "@oh-my-pi/app-wire";
import { createAppserver, type LocalAppserver } from "../src/server.ts";
import type { ChildHandle, RpcChildFactory, SessionDiscovery, SessionRecord } from "../src/types.ts";
import { RawUdsWebSocket } from "./raw-uds-client.ts";

const testHost = hostId("broadcast-order-host");
const testEpoch = "broadcast-order-epoch";
const stamp = "2026-01-01T00:00:00.000Z";
const session = sessionId("broadcast-session");
const rid = (value: string) => value as never;

function hello(): Record<string, unknown> {
	return {
		v: "omp-app/1",
		type: "hello",
		protocol: { min: "omp-app/1", max: "omp-app/1" },
		client: { name: "broadcast-order-test", version: "1", build: "test", platform: "linux" },
		requestedFeatures: ["resume", "agent.transcript"],
		savedCursors: [],
		capabilities: { client: ["sessions.read", "sessions.prompt"] },
	};
}

function command(
	requestId: string,
	commandId: string,
	name: string,
	args: Record<string, unknown>,
): Record<string, unknown> {
	return {
		v: "omp-app/1",
		type: "command",
		requestId: rid(requestId),
		commandId: rid(commandId),
		hostId: testHost,
		sessionId: session,
		command: name,
		args,
	};
}

function record(): SessionRecord {
	return {
		sessionId: session,
		path: "/tmp/broadcast-order-session.jsonl",
		cwd: "/tmp",
		projectId: projectId("broadcast-order-project"),
		title: "Broadcast ordering",
		updatedAt: stamp,
		status: "idle",
		entries: [],
	};
}

class StaticDiscovery implements SessionDiscovery {
	async list(): Promise<SessionRecord[]> {
		return [record()];
	}
}

class BurstChild implements ChildHandle {
	readonly writes: string[] = [];
	readonly killed = Promise.withResolvers<void>();
	readonly killSignals: string[] = [];
	readonly #exit = Promise.withResolvers<number>();
	readonly exited = this.#exit.promise;
	readonly #lines: string[] = [];
	readonly #waiters: Array<{ resolve: (line: string | undefined) => void }> = [];
	readonly #writeWaiters: Array<{ count: number; resolve: () => void }> = [];
	readonly stdin = {
		write: (data: string) => {
			this.writes.push(data);
			for (const waiter of this.#writeWaiters.splice(0)) {
				if (this.writes.length >= waiter.count) waiter.resolve();
				else this.#writeWaiters.push(waiter);
			}
		},
	};
	readonly stdout: AsyncIterable<string> = this.stream();
	readonly stderr: AsyncIterable<string> = (async function* () {})();

	async *stream(): AsyncGenerator<string> {
		yield `${JSON.stringify({ type: "ready" })}\n`;
		while (true) {
			const line = this.#lines.shift() ?? (await this.nextLine());
			if (line === undefined) return;
			yield line;
		}
	}

	private nextLine(): Promise<string | undefined> {
		const waiter = Promise.withResolvers<string | undefined>();
		this.#waiters.push(waiter);
		return waiter.promise;
	}

	push(value: Record<string, unknown>): void {
		const line = `${JSON.stringify(value)}\n`;
		const waiter = this.#waiters.shift();
		if (waiter) waiter.resolve(line);
		else this.#lines.push(line);
	}

	async waitForWrites(count: number): Promise<void> {
		if (this.writes.length >= count) return;
		const waiter = Promise.withResolvers<void>();
		this.#writeWaiters.push({ count, resolve: waiter.resolve });
		await waiter.promise;
	}

	kill(signal = "SIGTERM"): void {
		this.killSignals.push(signal);
		this.killed.resolve();
		this.release();
	}

	release(): void {
		const waiter = this.#waiters.shift();
		waiter?.resolve(undefined);
		this.#exit.resolve(0);
	}
}

class BurstFactory implements RpcChildFactory {
	readonly children: BurstChild[] = [];
	readonly #spawned = Promise.withResolvers<BurstChild>();

	spawn(): ChildHandle {
		const child = new BurstChild();
		this.children.push(child);
		this.#spawned.resolve(child);
		return child;
	}

	argv(): string[] {
		return ["fake-omp", "--mode", "rpc"];
	}

	async child(): Promise<BurstChild> {
		return this.children[0] ?? this.#spawned.promise;
	}
}

async function readyClient(path: string): Promise<RawUdsWebSocket> {
	const client = await RawUdsWebSocket.connect(path);
	client.sendJson(hello());
	expect((await client.nextServer()).type).toBe("welcome");
	expect((await client.nextServer()).type).toBe("sessions");
	return client;
}

async function attach(client: RawUdsWebSocket, suffix: string): Promise<void> {
	client.sendJson(command(`attach-${suffix}`, `attach-${suffix}`, "session.attach", {}));
	const response = await client.nextServer();
	const snapshot = await client.nextServer();
	expect(response).toMatchObject({ type: "response", ok: true });
	expect(snapshot).toMatchObject({ type: "snapshot", sessionId: session });
}

async function nextServerWithin(client: RawUdsWebSocket, timeoutMs = 2_000): Promise<ServerFrame> {
	// Real socket integration needs a hang bound; fake timers cannot advance kernel I/O.
	return await Promise.race([
		client.nextServer(),
		Bun.sleep(timeoutMs).then(() => {
			throw new Error(`timed out waiting for server frame after ${timeoutMs}ms`);
		}),
	]);
}

function promptEntry(index: number): Record<string, unknown> {
	return {
		type: "message",
		id: `burst-entry-${index}`,
		parentId: null,
		timestamp: stamp,
		message: {
			role: "assistant",
			content: [{ type: "text", text: `durable burst ${index}` }],
		},
	};
}

function workerEntry(worker: string, index: number): Record<string, unknown> {
	return {
		type: "message",
		id: `${worker}-entry-${index}`,
		parentId: null,
		timestamp: stamp,
		message: {
			role: "assistant",
			content: [{ type: "text", text: `${worker} transcript ${index}` }],
		},
	};
}

function subagentLifecycle(worker: string): Record<string, unknown> {
	return {
		type: "subagent_lifecycle",
		payload: {
			id: worker,
			index: 0,
			agent: "task",
			agentSource: "bundled",
			description: `Worker ${worker}`,
			status: "started",
			lastUpdate: 100,
		},
	};
}

function transcriptResponse(child: BurstChild, request: Record<string, unknown>, worker: string): void {
	const fromByte = Number(request.fromByte ?? 0);
	const generation = fromByte / 100;
	const nextByte = generation >= 2 ? fromByte : fromByte + 100;
	child.push({
		type: "response",
		id: request.id,
		command: "get_subagent_messages",
		success: true,
		data: {
			sessionFile: `/tmp/${worker}.jsonl`,
			fromByte,
			nextByte,
			reset: false,
			entries: generation < 2 ? [workerEntry(worker, generation + 1)] : [],
			messages: [],
		},
	});
}

async function respondAllTranscriptReads(child: BurstChild, workers: string[]): Promise<void> {
	const responseCount = new Map<string, number>();
	while ([...responseCount.values()].reduce((total, count) => total + count, 0) < workers.length * 3) {
		await child.waitForWrites(child.writes.length + 1);
		for (const raw of child.writes) {
			const frame = JSON.parse(raw) as Record<string, unknown>;
			if (frame.type !== "get_subagent_messages" || typeof frame.id !== "string") continue;
			const worker = String(frame.subagentId);
			const seen = responseCount.get(frame.id) ?? 0;
			if (seen > 0) continue;
			responseCount.set(frame.id, seen + 1);
			transcriptResponse(child, frame, worker);
		}
	}
}

async function closeClient(client: RawUdsWebSocket): Promise<void> {
	client.destroy();
	await client.closed();
}

describe("appserver broadcast ordering under a slow reader", () => {
	test("fast reader converges over 100+ mixed frames while unread reader stays bounded and cleans up", async () => {
		const factory = new BurstFactory();
		const root = await mkdtemp(join(tmpdir(), "omp-broadcast-order-"));
		const appserver: LocalAppserver = createAppserver({
			hostId: testHost,
			epoch: testEpoch,
			socketPath: join(root, "run", "app.sock"),
			discovery: new StaticDiscovery(),
			childFactory: factory,
			ringSize: 256,
		});
		let fast: RawUdsWebSocket | undefined;
		let slow: RawUdsWebSocket | undefined;
		try {
			await appserver.start();
			fast = await readyClient(appserver.socketPath);
			slow = await readyClient(appserver.socketPath);
			await attach(fast, "fast");
			await attach(slow, "slow");

			fast.sendJson(command("burst-prompt", "burst-prompt", "session.prompt", { message: "start burst" }));
			const child = await factory.child();
			await child.waitForWrites(1);
			const promptFrames = [await fast.nextServer(), await fast.nextServer(), await fast.nextServer()];
			expect(promptFrames.map(frame => frame.type)).toEqual(["session.delta", "session.delta", "event"]);

			const durableCount = 35;
			const eventCount = 35;
			const workers = Array.from({ length: 20 }, (_, index) => `Worker-${index}`);
			for (let index = 0; index < durableCount; index++) {
				child.push({ type: "session_entry", entry: promptEntry(index) });
				child.push({ type: "notice", level: "info", message: `burst-event-${index}`, at: stamp });
			}
			for (const worker of workers) child.push(subagentLifecycle(worker));
			const transcriptResponder = respondAllTranscriptReads(child, workers);

			const expectedEntryIds = new Set(
				Array.from({ length: durableCount }, (_, index) => entryId(`burst-entry-${index}`)),
			);
			const expectedEventMessages = new Set(
				Array.from({ length: eventCount }, (_, index) => `burst-event-${index}`),
			);
			const expectedWorkers = new Set(workers);
			const receivedEntries = new Map<string, number>();
			const receivedEvents = new Map<string, number>();
			const receivedTranscripts = new Map<string, number[]>();
			const mixedOrder: string[] = [];
			const receivedAgents = new Set<string>();
			const fastFrames: ServerFrame[] = [];
			const startedAt = performance.now();
			while (
				receivedEntries.size < expectedEntryIds.size ||
				receivedEvents.size < expectedEventMessages.size ||
				receivedTranscripts.size < expectedWorkers.size ||
				[...receivedTranscripts.values()].some(seqs => seqs.length < 2)
			) {
				const frame = await nextServerWithin(fast);
				fastFrames.push(frame);
				if (frame.type === "entry" && expectedEntryIds.has(frame.entry.id)) {
					receivedEntries.set(frame.entry.id, frame.cursor.seq);
					mixedOrder.push(`entry:${frame.entry.id}`);
				}
				if (
					frame.type === "event" &&
					frame.event.type === "notice" &&
					typeof frame.event.message === "string" &&
					expectedEventMessages.has(frame.event.message)
				) {
					receivedEvents.set(frame.event.message, frame.cursor.seq);
					mixedOrder.push(`event:${frame.event.message}`);
				}
				if (frame.type === "agent") receivedAgents.add(frame.agentId);
				if (frame.type === "agent.transcript" && expectedWorkers.has(frame.agentId)) {
					const cursors = receivedTranscripts.get(frame.agentId) ?? [];
					cursors.push(frame.cursor.seq);
					receivedTranscripts.set(frame.agentId, cursors);
				}
			}
			await transcriptResponder;
			expect(performance.now() - startedAt).toBeLessThan(2_000);
			expect(receivedEntries.size).toBe(35);
			expect(receivedEvents.size).toBe(35);
			expect(receivedTranscripts.size).toBe(20);
			expect(receivedAgents).toEqual(expectedWorkers);
			expect(fastFrames.length).toBeGreaterThanOrEqual(130);

			for (const seqs of receivedTranscripts.values()) expect(seqs).toEqual([1, 2]);
			const expectedMixedOrder = Array.from({ length: durableCount }, (_, index) => [
				`entry:burst-entry-${index}`,
				`event:burst-event-${index}`,
			]).flat();
			expect(mixedOrder).toEqual(expectedMixedOrder);
			const mixedCursors = [...receivedEntries.entries(), ...receivedEvents.entries()]
				.map(([, seq]) => seq)
				.sort((left, right) => left - right);
			expect(mixedCursors).toEqual(mixedCursors.map((_, index) => mixedCursors[0]! + index));
			expect(promptFrames.filter(frame => frame.type === "session.delta").map(frame => frame.cursor.seq)).toEqual([
				1, 2,
			]);
			for (const cursor of receivedEntries.values()) expect(cursor).toBeGreaterThan(0);
			for (const cursor of receivedEvents.values()) expect(cursor).toBeGreaterThan(0);
			expect(fastFrames.length).toBeLessThan(200);
			expect(appserver.snapshot(session)?.ring.length).toBeGreaterThanOrEqual(70);
		} finally {
			if (fast) await closeClient(fast);
			await appserver.stop();
			if (slow) await slow.closed();
			await rm(root, { recursive: true, force: true });
		}
	});
});
