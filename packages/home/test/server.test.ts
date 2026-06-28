import { describe, expect, it } from "bun:test";
import { isLoopbackHost } from "../src/server";

describe("home server loopback host guard", () => {
	it("accepts loopback hostnames", () => {
		expect(isLoopbackHost("localhost")).toBe(true);
		expect(isLoopbackHost("LOCALHOST")).toBe(true);
		expect(isLoopbackHost("127.0.0.1")).toBe(true);
		// The whole 127.0.0.0/8 range is loopback.
		expect(isLoopbackHost("127.1.2.3")).toBe(true);
		expect(isLoopbackHost("127.255.255.255")).toBe(true);
		// IPv6 loopback, both the WHATWG `URL.hostname` bracketed form and bare.
		expect(isLoopbackHost("[::1]")).toBe(true);
		expect(isLoopbackHost("::1")).toBe(true);
	});

	it("rejects DNS-rebinding and non-loopback hostnames", () => {
		expect(isLoopbackHost("attacker.example")).toBe(false);
		expect(isLoopbackHost("evil.com")).toBe(false);
		// Wildcard/loopback-aliased DNS names must not be treated as loopback.
		expect(isLoopbackHost("127.0.0.1.nip.io")).toBe(false);
		expect(isLoopbackHost("localhost.evil.com")).toBe(false);
		// Non-loopback private/any addresses are still rejected.
		expect(isLoopbackHost("0.0.0.0")).toBe(false);
		expect(isLoopbackHost("10.0.0.1")).toBe(false);
		// A digit-prefixed attacker domain is not a 127/8 address.
		expect(isLoopbackHost("127.attacker.com")).toBe(false);
		expect(isLoopbackHost("127.999.0.1")).toBe(false);
	});
});
