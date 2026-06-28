import { afterEach, describe, expect, it } from "bun:test";
import { startRuntimeServer } from "./server";

let stopServer: (() => void) | undefined;

afterEach(() => {
	stopServer?.();
	stopServer = undefined;
});

describe("mechanism server CORS", () => {
	it("rejects foreign-origin SSE reads while allowing same-origin loopback", async () => {
		const server = await startRuntimeServer(0);
		stopServer = server.stop;
		const url = `http://localhost:${server.port}/events`;

		const foreign = await fetch(url, { headers: { Origin: "https://evil.example" } });
		expect(foreign.status).toBe(403);
		expect(foreign.headers.get("Access-Control-Allow-Origin")).toBeNull();

		const sameOrigin = await fetch(url, { headers: { Origin: `http://localhost:${server.port}` } });
		expect(sameOrigin.status).toBe(200);
		expect(sameOrigin.headers.get("content-type")).toContain("text/event-stream");
		expect(sameOrigin.headers.get("Access-Control-Allow-Origin")).toBe(`http://localhost:${server.port}`);
		await sameOrigin.body?.cancel();
	});
});
