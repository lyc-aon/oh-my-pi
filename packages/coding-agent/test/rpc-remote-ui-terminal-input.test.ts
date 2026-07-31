import { describe, expect, test } from "bun:test";
import {
	RPC_REMOTE_UI_BOUNDS,
	RpcRemoteUiHost,
	type RpcRemoteUiOutput,
	type RpcTerminalInputHandler,
} from "../src/modes/rpc/rpc-remote-ui";
import { RPC_FRONTEND_PROTOCOL_V } from "../src/modes/rpc/rpc-types";

type Frame = Record<string, unknown>;

function captureHost(): {
	frames: Frame[];
	host: RpcRemoteUiHost;
	ofType: (type: string) => Frame[];
	clear: () => void;
} {
	const frames: Frame[] = [];
	const output: RpcRemoteUiOutput = frame => {
		frames.push(frame as Frame);
	};
	const host = new RpcRemoteUiHost(output);
	return {
		frames,
		host,
		ofType: (type: string) => frames.filter(f => f.type === type),
		clear: () => {
			frames.length = 0;
		},
	};
}

describe("RpcRemoteUiHost terminal-input listeners", () => {
	test("old no-listener path emits result without subscription churn", () => {
		const { host, ofType, frames } = captureHost();

		// Baseline: zero listeners → no subscription frames ever.
		expect(host.hasTerminalInputListeners).toBe(false);
		expect(ofType("terminal_input_subscription")).toHaveLength(0);

		const ok = host.handleIncoming({
			type: "terminal_input",
			id: "nl-1",
			text: "hello",
		});
		expect(ok).toBe(true);

		expect(ofType("terminal_input_subscription")).toHaveLength(0);
		expect(ofType("terminal_input_result")).toEqual([
			expect.objectContaining({
				v: RPC_FRONTEND_PROTOCOL_V,
				type: "terminal_input_result",
				id: "nl-1",
				consume: false,
				data: "hello",
			}),
		]);
		// No subscription frames mixed into the wire stream.
		expect(frames.every(f => f.type !== "terminal_input_subscription")).toBe(true);
	});

	test("subscription emits only on 0→1 and 1→0 transitions", () => {
		const { host, ofType } = captureHost();
		const h1: RpcTerminalInputHandler = () => undefined;
		const h2: RpcTerminalInputHandler = () => undefined;

		const unsub1 = host.addTerminalInputListener(h1);
		expect(ofType("terminal_input_subscription")).toEqual([
			expect.objectContaining({ type: "terminal_input_subscription", active: true }),
		]);
		expect(host.hasTerminalInputListeners).toBe(true);

		const unsub2 = host.addTerminalInputListener(h2);
		// Second listener must not re-emit active:true.
		expect(ofType("terminal_input_subscription")).toHaveLength(1);

		unsub1();
		expect(ofType("terminal_input_subscription")).toHaveLength(1);
		expect(host.hasTerminalInputListeners).toBe(true);

		unsub2();
		expect(ofType("terminal_input_subscription")).toEqual([
			expect.objectContaining({ active: true }),
			expect.objectContaining({ active: false }),
		]);
		expect(host.hasTerminalInputListeners).toBe(false);

		// Repeated unsubscribe is a no-op (no extra churn).
		unsub2();
		unsub1();
		expect(ofType("terminal_input_subscription")).toHaveLength(2);
	});

	test("listeners run in registration order with transform then consume", () => {
		const { host, ofType } = captureHost();
		const seen: string[] = [];

		host.addTerminalInputListener(data => {
			seen.push(`a:${data}`);
			return { data: `${data}+A` };
		});
		host.addTerminalInputListener(data => {
			seen.push(`b:${data}`);
			return { data: `${data}+B` };
		});
		host.addTerminalInputListener(data => {
			seen.push(`c:${data}`);
			return { consume: true };
		});
		host.addTerminalInputListener(data => {
			seen.push(`d:${data}`);
			return undefined;
		});

		// Clear subscription open frame noise.
		ofType("terminal_input_subscription");

		host.handleIncoming({ type: "terminal_input", id: "ord-1", text: "x" });
		expect(seen).toEqual(["a:x", "b:x+A", "c:x+A+B"]);
		// d never runs after consume.
		expect(ofType("terminal_input_result").at(-1)).toMatchObject({
			id: "ord-1",
			consume: true,
		});
		expect(ofType("terminal_input_result").at(-1)!.data).toBeUndefined();
	});

	test("empty transform data consumes like TUI pipeline drop", () => {
		const { host, ofType } = captureHost();
		host.addTerminalInputListener(() => ({ data: "" }));
		host.handleIncoming({ type: "terminal_input", id: "empty-1", text: "keep" });
		expect(ofType("terminal_input_result").at(-1)).toMatchObject({
			id: "empty-1",
			consume: true,
		});
	});

	test("per-listener exceptions isolate; remaining chain and result still emit JSON", () => {
		const { host, ofType } = captureHost();
		const seen: string[] = [];

		host.addTerminalInputListener(() => {
			seen.push("thrower");
			throw new Error("listener-boom");
		});
		host.addTerminalInputListener(data => {
			seen.push(`ok:${data}`);
			return { data: data.toUpperCase() };
		});

		host.handleIncoming({ type: "terminal_input", id: "ex-1", text: "ab" });
		expect(seen).toEqual(["thrower", "ok:ab"]);
		const result = ofType("terminal_input_result").at(-1)!;
		expect(result).toMatchObject({
			id: "ex-1",
			consume: false,
			data: "AB",
			error: "listener-boom",
		});
		// Error never writes non-JSON: result is a plain object frame.
		const encoded = JSON.stringify(result);
		expect(encoded).toContain("terminal_input_result");
		expect(encoded).toContain("listener-boom");
		expect(typeof result).toBe("object");
		expect(result).not.toBeNull();
	});

	test("duplicate terminal_input id acks consume without re-running listeners", () => {
		const { host, ofType } = captureHost();
		let calls = 0;
		host.addTerminalInputListener(() => {
			calls += 1;
			return undefined;
		});

		host.handleIncoming({ type: "terminal_input", id: "dup-1", text: "one" });
		host.handleIncoming({ type: "terminal_input", id: "dup-1", text: "two" });

		expect(calls).toBe(1);
		const results = ofType("terminal_input_result").filter(f => f.id === "dup-1");
		expect(results).toHaveLength(2);
		expect(results[0]).toMatchObject({ consume: false, data: "one" });
		// Duplicate: harmless already-consumed ack.
		expect(results[1]).toMatchObject({ id: "dup-1", consume: true });
		expect(results[1]!.data).toBeUndefined();
	});

	test("missing id drops silently; missing data/text errors", () => {
		const { host, ofType, frames } = captureHost();
		const n = frames.length;
		host.handleIncoming({ type: "terminal_input", text: "no-id" } as never);
		expect(frames.length).toBe(n);

		host.handleIncoming({ type: "terminal_input", id: "miss-1" });
		expect(ofType("terminal_input_result").at(-1)).toMatchObject({
			id: "miss-1",
			consume: false,
			error: "missing data/text",
		});
	});

	test("64KiB clamp on inbound terminal text and outbound transformed data", () => {
		const { host, ofType } = captureHost();
		const max = RPC_REMOTE_UI_BOUNDS.maxTerminalInputChars;
		expect(max).toBe(64 * 1024);

		// No listeners: inbound clamp on ack data.
		const huge = "H".repeat(max + 50);
		host.handleIncoming({ type: "terminal_input", id: "big-1", text: huge });
		const ack = ofType("terminal_input_result").at(-1)!;
		expect((ack.data as string).length).toBe(max);

		// With transform that expands past bound: outbound clamp.
		host.addTerminalInputListener(() => ({ data: "Z".repeat(max + 20) }));
		host.handleIncoming({ type: "terminal_input", id: "big-2", text: "x" });
		const transformed = ofType("terminal_input_result").at(-1)!;
		expect(transformed.consume).toBe(false);
		expect((transformed.data as string).length).toBe(max);
	});

	test("256 seen-id bound forgets oldest so id can be handled again", () => {
		const { host, ofType } = captureHost();
		const bound = RPC_REMOTE_UI_BOUNDS.maxTerminalInputSeenIds;
		expect(bound).toBe(256);

		let calls = 0;
		host.addTerminalInputListener(() => {
			calls += 1;
			return undefined;
		});

		// Fill the seen-id ring with unique ids.
		for (let i = 0; i < bound; i++) {
			host.handleIncoming({ type: "terminal_input", id: `id-${i}`, text: "t" });
		}
		expect(calls).toBe(bound);

		// id-0 is still remembered → duplicate ack, no listener call.
		const callsAfterFull = calls;
		host.handleIncoming({ type: "terminal_input", id: "id-0", text: "again" });
		expect(calls).toBe(callsAfterFull);
		expect(ofType("terminal_input_result").at(-1)).toMatchObject({
			id: "id-0",
			consume: true,
		});

		// Push one more unique id to evict id-0 from the 256 window.
		host.handleIncoming({ type: "terminal_input", id: "id-new", text: "n" });
		expect(calls).toBe(callsAfterFull + 1);

		// id-0 is forgotten → listeners run again.
		host.handleIncoming({ type: "terminal_input", id: "id-0", text: "revived" });
		expect(calls).toBe(callsAfterFull + 2);
		expect(ofType("terminal_input_result").at(-1)).toMatchObject({
			id: "id-0",
			consume: false,
			data: "revived",
		});
	});

	test("disposeAll clears listeners and emits active:false when any were registered", () => {
		const { host, ofType, frames } = captureHost();
		host.addTerminalInputListener(() => undefined);
		expect(ofType("terminal_input_subscription").at(-1)).toMatchObject({ active: true });

		host.disposeAll("done");
		expect(host.hasTerminalInputListeners).toBe(false);
		expect(ofType("terminal_input_subscription").at(-1)).toMatchObject({ active: false });

		// After dispose, further terminal_input is still claimed but emits nothing (host disposed).
		const n = frames.length;
		host.handleIncoming({ type: "terminal_input", id: "post", text: "x" });
		// handleTerminalInput still runs remember/result path but #emitTerminalInputResult no-ops when disposed.
		expect(frames.length).toBe(n);

		// disposeAll with zero listeners never emitted subscription false.
		const fresh = captureHost();
		fresh.host.disposeAll();
		expect(fresh.ofType("terminal_input_subscription")).toHaveLength(0);
	});

	test("data bytes array decodes to utf8 text", () => {
		const { host, ofType } = captureHost();
		host.handleIncoming({
			type: "terminal_input",
			id: "bytes-1",
			data: Array.from(Buffer.from("xyz", "utf8")),
		});
		expect(ofType("terminal_input_result").at(-1)).toMatchObject({
			id: "bytes-1",
			consume: false,
			data: "xyz",
		});
	});
});
