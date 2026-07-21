import { describe, expect, test } from "bun:test";
import { hostId, projectId, sessionId } from "@oh-my-pi/app-wire";
import {
	decodeOmpAuthorityBridgeServerFrame,
	encodeOmpAuthorityBridgeFrame,
	OMP_AUTHORITY_BRIDGE_MAX_LINE_BYTES,
	OMP_AUTHORITY_BRIDGE_PROTOCOL,
} from "@oh-my-pi/appserver";
import { runOmpAuthorityBridge } from "../src/cli/appserver-bridge-cli";

class AsyncQueue implements AsyncIterable<string> {
	readonly #values: string[] = [];
	readonly #waiters: Array<(value: IteratorResult<string>) => void> = [];
	#closed = false;
	push(value: string): void {
		const waiter = this.#waiters.shift();
		if (waiter) waiter({ done: false, value });
		else this.#values.push(value);
	}
	close(): void {
		this.#closed = true;
		for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
	}
	[Symbol.asyncIterator](): AsyncIterator<string> {
		return {
			next: () => {
				const value = this.#values.shift();
				if (value !== undefined) return Promise.resolve({ done: false, value });
				if (this.#closed) return Promise.resolve({ done: true, value: undefined });
				return new Promise(resolve => this.#waiters.push(resolve));
			},
		};
	}
}

function session() {
	return {
		sessionId: sessionId("session-test"),
		path: "/tmp/session-test.jsonl",
		cwd: "/tmp/project",
		projectId: projectId("project-test"),
		title: "Test",
		updatedAt: new Date(0).toISOString(),
		status: "idle" as const,
		entries: [],
	};
}

function runtime() {
	const record = session();
	const sessionAuthority = {
		create: async () => ({ ...record }),
		list: async () => [record],
		archive: async () => {},
		restore: async () => {},
		delete: async () => {},
	};
	return {
		sessionAuthority,
		discovery: { list: sessionAuthority.list, load: async () => record },
		operationsAuthority: {
			termOpen: async (_args: unknown, context: { emitTerminalOutput?: (frame: unknown) => void }) => {
				context.emitTerminalOutput?.({
					v: "omp-app/1",
					type: "terminal.output",
					hostId: hostId("host-test"),
					sessionId: record.sessionId,
					terminalId: "terminal-test",
					cursor: { epoch: "terminal", seq: 1 },
					stream: "stdout",
					data: "ready",
				});
				return { terminalId: "terminal-test" };
			},
			terminalInput: async () => {},
			terminalResize: async () => {},
			terminalClose: async () => {},
		},
		projectRootForProject: async () => record.cwd,
		projectRootForSession: async () => record.cwd,
		lockCheck: () => {},
		lockStatus: () => "missing" as const,
		transcriptSearchAuthority: {},
	} as never;
}

function request(id: string, method: "session.list" | "operation.termOpen", params: Record<string, unknown>) {
	return encodeOmpAuthorityBridgeFrame({
		v: OMP_AUTHORITY_BRIDGE_PROTOCOL,
		type: "request",
		id,
		method,
		params,
	});
}

describe("thin OMP authority bridge", () => {
	test("advertises concrete methods and serves sessions plus terminal events over stdio", async () => {
		const input = new AsyncQueue();
		const output: string[] = [];
		const running = runOmpAuthorityBridge({
			runtime: runtime(),
			input,
			write: line => {
				output.push(line);
			},
			identity: { ompVersion: "17.0.5", ompBuild: "bridge-test" },
		});
		input.push(request("list-1", "session.list", {}));
		input.push(
			request("term-1", "operation.termOpen", {
				args: {},
				context: {
					hostId: "host-test",
					sessionId: "session-test",
					deviceId: "device-test",
					connectionId: "connection-test",
					capabilities: ["term.open"],
				},
			}),
		);
		input.close();
		await running;
		const frames = output.map(line => decodeOmpAuthorityBridgeServerFrame(JSON.parse(line)));
		expect(frames[0]).toMatchObject({
			type: "ready",
			ompVersion: "17.0.5",
			methods: expect.arrayContaining(["host.info", "session.list", "operation.termOpen", "terminal.close"]),
		});
		expect(frames[0]).not.toMatchObject({ methods: expect.arrayContaining(["operation.filesRead"]) });
		expect(frames).toContainEqual(expect.objectContaining({ type: "response", id: "list-1", ok: true }));
		expect(frames).toContainEqual(expect.objectContaining({ type: "event", id: "term-1", event: "terminal" }));
		expect(frames).toContainEqual(
			expect.objectContaining({
				type: "response",
				id: "term-1",
				ok: true,
				result: { terminalId: "terminal-test" },
			}),
		);
	});

	test("rejects malformed frames before invoking authority code", async () => {
		const input = new AsyncQueue();
		const running = runOmpAuthorityBridge({
			runtime: runtime(),
			input,
			write: () => {},
			identity: { ompVersion: "17.0.5", ompBuild: "bridge-test" },
		});
		input.push(
			`${JSON.stringify({
				v: OMP_AUTHORITY_BRIDGE_PROTOCOL,
				type: "request",
				id: "bad-1",
				method: "session.list",
				params: {},
				extra: true,
			})}\n`,
		);
		input.close();
		await expect(running).rejects.toThrow("unknown or missing fields");
	});

	test("rejects an oversized unfinished input frame", async () => {
		const input = new AsyncQueue();
		const running = runOmpAuthorityBridge({
			runtime: runtime(),
			input,
			write: () => {},
			identity: { ompVersion: "17.0.5", ompBuild: "bridge-test" },
		});
		input.push("x".repeat(OMP_AUTHORITY_BRIDGE_MAX_LINE_BYTES + 1));
		await expect(running).rejects.toThrow("bridge input exceeds the line limit");
	});

	test("keeps serving when a success payload exceeds the frame limit", async () => {
		const input = new AsyncQueue();
		const output: string[] = [];
		const huge = {
			sessionId: sessionId("huge"),
			path: "/tmp/huge.jsonl",
			cwd: "/tmp",
			projectId: projectId("project"),
			title: "huge",
			updatedAt: "2026-01-01T00:00:00.000Z",
			status: "idle" as const,
			entries: [{ id: "e1", role: "assistant", text: "x".repeat(OMP_AUTHORITY_BRIDGE_MAX_LINE_BYTES) }],
		};
		let calls = 0;
		const base = runtime();
		const customRuntime = {
			...base,
			sessionAuthority: {
				...base.sessionAuthority,
				list: async () => {
					calls += 1;
					return calls === 1 ? [huge] : [session()];
				},
			},
		} as never;
		const running = runOmpAuthorityBridge({
			runtime: customRuntime,
			input,
			write: async line => {
				output.push(line);
			},
			identity: { ompVersion: "17.0.5", ompBuild: "test" },
		});
		// Wait for ready
		await Bun.sleep(20);
		input.push(
			encodeOmpAuthorityBridgeFrame({
				v: OMP_AUTHORITY_BRIDGE_PROTOCOL,
				type: "request",
				id: "big-1",
				method: "session.list",
				params: {},
			}),
		);
		// Give the bridge time to attempt the oversized encode and recover
		await Bun.sleep(50);
		input.push(
			encodeOmpAuthorityBridgeFrame({
				v: OMP_AUTHORITY_BRIDGE_PROTOCOL,
				type: "request",
				id: "ok-2",
				method: "session.list",
				params: {},
			}),
		);
		await Bun.sleep(50);
		input.close();
		await running;
		const frames = output.map(line => decodeOmpAuthorityBridgeServerFrame(JSON.parse(line)));
		const ready = frames.find(frame => frame.type === "ready");
		expect(ready).toBeDefined();
		const big = frames.find(frame => frame.type === "response" && frame.id === "big-1");
		expect(big).toMatchObject({
			type: "response",
			id: "big-1",
			ok: false,
			error: { code: "RESPONSE_TOO_LARGE" },
		});
		// Bridge must still answer the follow-up request after the oversized failure.
		const ok = frames.find(frame => frame.type === "response" && frame.id === "ok-2");
		expect(ok).toMatchObject({ type: "response", id: "ok-2", ok: true });
		expect(calls).toBe(2);
	});

});
