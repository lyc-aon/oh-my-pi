import { beforeAll, describe, expect, test } from "bun:test";
import type { Component, TUI } from "@oh-my-pi/pi-tui";
import { CURSOR_MARKER } from "@oh-my-pi/pi-tui";
import { buildThemeSyncFrame } from "../src/modes/rpc/rpc-mode";
import {
	linesToComponent,
	RPC_REMOTE_UI_BOUNDS,
	RpcRemoteUiHost,
	type RpcRemoteUiOutput,
} from "../src/modes/rpc/rpc-remote-ui";
import { RPC_FRONTEND_PROTOCOL_V } from "../src/modes/rpc/rpc-types";
import type { Theme } from "../src/modes/theme/theme";
import { initTheme } from "../src/modes/theme/theme";

type Frame = Record<string, unknown>;

beforeAll(async () => {
	await initTheme(false);
});

function captureHost(): { frames: Frame[]; host: RpcRemoteUiHost; ofType: (type: string) => Frame[] } {
	const frames: Frame[] = [];
	const output: RpcRemoteUiOutput = frame => {
		frames.push(frame as Frame);
	};
	const host = new RpcRemoteUiHost(output);
	return {
		frames,
		host,
		ofType: (type: string) => frames.filter(f => f.type === type),
	};
}

function fakeComponent(opts?: {
	lines?: string[] | ((width: number) => string[]);
	onInput?: (data: string) => void;
	onMouse?: (event: unknown, line: number, col: number) => void;
	onDispose?: () => void;
	getText?: () => string;
	setText?: (text: string) => void;
	wantsKeyRelease?: boolean;
	throwOnRender?: Error | string;
	throwOnInput?: Error | string;
}): Component & {
	focused?: boolean;
	dispose?: () => void;
	handleInput?: (data: string) => void;
	routeMouse?: (
		event: {
			button: number;
			col: number;
			row: number;
			release: boolean;
			wheel: -1 | 1 | null;
			motion: boolean;
			leftClick: boolean;
		},
		line: number,
		col: number,
	) => void;
	getText?: () => string;
	setText?: (text: string) => void;
	setUseTerminalCursor?: (use: boolean) => void;
	setIgnoreTight?: (ignore: boolean) => void;
	wantsKeyRelease?: boolean;
	lastWidth?: number;
	lastInput?: string;
	lastMouse?: unknown;
	disposed?: boolean;
	useTerminalCursor?: boolean;
	ignoreTight?: boolean;
} {
	const c = {
		focused: false,
		lastWidth: undefined as number | undefined,
		lastInput: undefined as string | undefined,
		lastMouse: undefined as unknown,
		disposed: false,
		useTerminalCursor: false,
		ignoreTight: false,
		wantsKeyRelease: opts?.wantsKeyRelease,
		render(width: number): string[] {
			c.lastWidth = width;
			if (opts?.throwOnRender) {
				throw opts.throwOnRender instanceof Error ? opts.throwOnRender : new Error(String(opts.throwOnRender));
			}
			if (typeof opts?.lines === "function") return opts.lines(width);
			return opts?.lines ?? ["ok"];
		},
		handleInput(data: string) {
			if (opts?.throwOnInput) {
				throw opts.throwOnInput instanceof Error ? opts.throwOnInput : new Error(String(opts.throwOnInput));
			}
			c.lastInput = data;
			opts?.onInput?.(data);
		},
		routeMouse(
			event: {
				button: number;
				col: number;
				row: number;
				release: boolean;
				wheel: -1 | 1 | null;
				motion: boolean;
				leftClick: boolean;
			},
			line: number,
			col: number,
		) {
			c.lastMouse = { event, line, col };
			opts?.onMouse?.(event, line, col);
		},
		dispose() {
			c.disposed = true;
			opts?.onDispose?.();
		},
		getText: opts?.getText,
		setText: opts?.setText,
		setUseTerminalCursor(use: boolean) {
			c.useTerminalCursor = use;
		},
		setIgnoreTight(ignore: boolean) {
			c.ignoreTight = ignore;
		},
	};
	return c;
}

function openId(frames: Frame[], kind?: string): string {
	const open = frames.find(f => f.type === "component_open" && (kind === undefined || f.kind === kind));
	expect(open).toBeDefined();
	expect(typeof open!.componentId).toBe("string");
	return open!.componentId as string;
}

describe("RpcRemoteUiHost component factory mount/render", () => {
	test("footer factory emits component_open and renders ANSI rows with width clamp + cursor", () => {
		const { host, ofType } = captureHost();
		let sawTui: TUI | undefined;
		let sawTheme: Theme | undefined;

		host.setFooterFactory((tui, th) => {
			sawTui = tui;
			sawTheme = th;
			return fakeComponent({
				lines: width => [`w=${width}`, `hi${CURSOR_MARKER}there`],
			});
		});

		expect(ofType("component_open")).toHaveLength(1);
		const open = ofType("component_open")[0]!;
		expect(open).toMatchObject({
			v: RPC_FRONTEND_PROTOCOL_V,
			type: "component_open",
			slot: "footer",
			kind: "extension_footer",
		});
		expect(typeof open.componentId).toBe("string");
		expect(sawTui).toBeDefined();
		expect(sawTui!.terminal.columns).toBe(80);
		expect(sawTheme).toBeDefined();

		const componentId = open.componentId as string;
		host.handleIncoming({
			type: "component_render",
			id: "r1",
			componentId,
			width: 9999,
			generation: 3,
		});

		const results = ofType("component_result");
		expect(results).toHaveLength(1);
		const result = results[0]!;
		expect(result).toMatchObject({
			v: RPC_FRONTEND_PROTOCOL_V,
			type: "component_result",
			id: "r1",
			componentId,
			generation: 3,
			cursorRow: 1,
			cursorCol: 2,
		});
		expect(result.lines).toEqual([`w=${RPC_REMOTE_UI_BOUNDS.maxRenderWidth}`, "hithere"]);
		expect(result.error).toBeUndefined();
		expect(JSON.stringify(result)).toContain("component_result");
	});

	test("render errors emit JSON component_result with error and empty lines", () => {
		const { host, ofType } = captureHost();
		host.setHeaderFactory(() =>
			fakeComponent({
				throwOnRender: new Error("boom-render"),
			}),
		);
		const componentId = openId(ofType("component_open"), "extension_header");

		const ok = host.handleIncoming({
			type: "component_render",
			id: "err1",
			componentId,
			width: 40,
		});
		expect(ok).toBe(true);

		const result = ofType("component_result")[0]!;
		expect(result.type).toBe("component_result");
		expect(result.error).toBe("boom-render");
		expect(result.lines).toEqual([]);
		// Must stay JSON-serializable object (never free-form text on the wire path).
		expect(() => JSON.stringify(result)).not.toThrow();
		expect(typeof result).toBe("object");
	});

	test("unknown component render returns error result", () => {
		const { host, ofType } = captureHost();
		host.handleIncoming({
			type: "component_render",
			id: "u1",
			componentId: "missing",
			width: 10,
		});
		expect(ofType("component_result")[0]).toMatchObject({
			id: "u1",
			componentId: "missing",
			lines: [],
			error: "unknown component: missing",
		});
	});

	test("render output truncated when rows exceed bound", () => {
		const { host, ofType } = captureHost();
		const rows = Array.from({ length: RPC_REMOTE_UI_BOUNDS.maxRenderRows + 5 }, (_, i) => `row-${i}`);
		host.setFooterFactory(() => fakeComponent({ lines: rows }));
		const componentId = openId(ofType("component_open"));

		host.handleIncoming({ type: "component_render", id: "t1", componentId, width: 20 });
		const result = ofType("component_result")[0]!;
		expect((result.lines as string[]).length).toBe(RPC_REMOTE_UI_BOUNDS.maxRenderRows);
		expect(result.error).toBe("render output truncated");
	});
});

describe("RpcRemoteUiHost component input", () => {
	test("key, paste, mouse, and data set handled/dirty on input_result", () => {
		const { host, ofType } = captureHost();
		const comp = fakeComponent();
		host.setFooterFactory(() => comp);
		const componentId = openId(ofType("component_open"));
		const before = ofType("component_input_result").length;

		host.handleIncoming({
			type: "component_input",
			id: "k1",
			componentId,
			key: "a",
		});
		expect(ofType("component_input_result").slice(before)[0]).toMatchObject({
			id: "k1",
			componentId,
			handled: true,
			dirty: true,
		});
		expect(comp.lastInput).toBe("a");

		host.handleIncoming({
			type: "component_input",
			id: "p1",
			componentId,
			paste: "pasted",
		});
		expect(comp.lastInput).toBe("\x1b[200~pasted\x1b[201~");
		expect(ofType("component_input_result").at(-1)).toMatchObject({
			id: "p1",
			handled: true,
			dirty: true,
		});

		host.handleIncoming({
			type: "component_input",
			id: "m1",
			componentId,
			mouse: { row: 2, col: 4, button: 0 },
		});
		expect(comp.lastMouse).toMatchObject({
			line: 2,
			col: 4,
			event: { button: 0, row: 2, col: 4, leftClick: true, release: false },
		});
		expect(ofType("component_input_result").at(-1)).toMatchObject({
			id: "m1",
			handled: true,
			dirty: true,
		});

		host.handleIncoming({
			type: "component_input",
			id: "d1",
			componentId,
			data: Buffer.from("raw").toString("utf8"),
		});
		expect(comp.lastInput).toBe("raw");
		expect(ofType("component_input_result").at(-1)).toMatchObject({
			id: "d1",
			handled: true,
			dirty: true,
		});
	});

	test("input error isolates to component_input_result error field", () => {
		const { host, ofType } = captureHost();
		host.setFooterFactory(() => fakeComponent({ throwOnInput: "nope" }));
		const componentId = openId(ofType("component_open"));

		host.handleIncoming({
			type: "component_input",
			id: "ie1",
			componentId,
			key: "x",
		});
		const result = ofType("component_input_result")[0]!;
		expect(result).toMatchObject({
			id: "ie1",
			handled: false,
			dirty: true,
			error: "nope",
		});
		expect(() => JSON.stringify(result)).not.toThrow();
	});

	test("paste body clamps to maxInputChars", () => {
		const { host, ofType } = captureHost();
		const comp = fakeComponent();
		host.setFooterFactory(() => comp);
		const componentId = openId(ofType("component_open"));
		const huge = "p".repeat(RPC_REMOTE_UI_BOUNDS.maxInputChars + 100);

		host.handleIncoming({
			type: "component_input",
			id: "clamp1",
			componentId,
			paste: huge,
		});
		// Paste is first sliced, then wrapped in bracketed-paste, then the whole
		// text is clamped again — final payload never exceeds maxInputChars.
		expect(comp.lastInput!.length).toBe(RPC_REMOTE_UI_BOUNDS.maxInputChars);
		expect(comp.lastInput!.startsWith("\x1b[200~")).toBe(true);
		expect(comp.lastInput!.startsWith(`\x1b[200~${"p".repeat(10)}`)).toBe(true);
	});
});

describe("RpcRemoteUiHost stable slot replacement/dispose", () => {
	test("replacing footer disposes previous and opens a new component", () => {
		const { host, ofType, frames } = captureHost();
		const first = fakeComponent();
		const second = fakeComponent();

		host.setFooterFactory(() => first);
		const firstId = openId(ofType("component_open"));

		host.setFooterFactory(() => second);
		const opens = ofType("component_open");
		expect(opens).toHaveLength(2);
		const secondId = opens[1]!.componentId as string;
		expect(secondId).not.toBe(firstId);

		const disposeFrames = ofType("component_dispose");
		expect(disposeFrames.some(f => f.componentId === firstId)).toBe(true);
		expect(first.disposed).toBe(true);
		expect(second.disposed).toBe(false);

		// Clearing factory disposes current slot.
		const nBefore = frames.length;
		host.setFooterFactory(undefined);
		expect(ofType("component_dispose").some(f => f.componentId === secondId)).toBe(true);
		expect(second.disposed).toBe(true);
		expect(frames.length).toBeGreaterThan(nBefore);
	});

	test("widget factory switches placement and removes prior key from both slots", () => {
		const { host, ofType } = captureHost();
		const above = fakeComponent();
		const below = fakeComponent();

		host.setWidgetFactory("w1", () => above, "aboveEditor");
		openId(ofType("component_open"), "extension_widget");
		expect(ofType("component_open")[0]).toMatchObject({
			slot: "widget_above",
			key: "w1",
		});

		host.setWidgetFactory("w1", () => below, "belowEditor");
		expect(above.disposed).toBe(true);
		const opens = ofType("component_open").filter(f => f.kind === "extension_widget");
		expect(opens.at(-1)).toMatchObject({
			slot: "widget_below",
			key: "w1",
		});
		expect(below.disposed).toBe(false);

		host.setWidgetFactory("w1", undefined);
		expect(below.disposed).toBe(true);
	});
});

describe("RpcRemoteUiHost custom done/cancel", () => {
	test("done(result) resolves mountCustom and emits dispose lifecycle", async () => {
		const { host, ofType } = captureHost();
		let callDone: ((v: string) => void) | undefined;

		const promise = host.mountCustom<string>((_tui, _theme, _kb, done) => {
			callDone = done;
			return fakeComponent({ lines: ["custom"] });
		});
		await Promise.resolve();

		expect(ofType("component_open")[0]).toMatchObject({
			slot: "custom",
			kind: "extension_custom",
		});
		const componentId = openId(ofType("component_open"), "extension_custom");
		expect(callDone).toBeDefined();
		callDone!("done-value");

		await expect(promise).resolves.toBe("done-value");
		expect(ofType("component_dispose").some(f => f.componentId === componentId)).toBe(true);
	});

	test("overlay custom emits overlay_mount; host dispose settles waiter", async () => {
		const { host, ofType } = captureHost();
		const promise = host.mountCustom<string>(() => fakeComponent(), { overlay: true });

		await Promise.resolve();
		const componentId = openId(ofType("component_open"), "extension_custom");
		expect(ofType("overlay_mount")[0]).toMatchObject({
			type: "overlay_mount",
			componentId,
			mode: "modal",
		});
		expect(typeof ofType("overlay_mount")[0]!.overlayId).toBe("string");

		host.handleIncoming({ type: "component_dispose", componentId });
		await expect(promise).resolves.toBeUndefined();
	});

	test("disposeAll rejects pending custom with reason", async () => {
		const { host } = captureHost();
		const promise = host.mountCustom(() => fakeComponent());
		host.disposeAll("shutdown-now");
		await expect(promise).rejects.toThrow("shutdown-now");
	});
});

describe("RpcRemoteUiHost nested overlay mount/hide/remount/dispose", () => {
	test("setHidden toggles unmount/remount; hide and dispose are idempotent once", () => {
		const { host, ofType, frames } = captureHost();
		let nestedTui: TUI | undefined;
		const nested = fakeComponent({ lines: ["nested"] });

		host.setFooterFactory(tui => {
			nestedTui = tui;
			return fakeComponent({ lines: ["owner"] });
		});
		openId(ofType("component_open"), "extension_footer");
		expect(nestedTui).toBeDefined();

		const handle = nestedTui!.showOverlay(nested, { fullscreen: false });
		const opens = ofType("component_open").filter(f => f.kind === "extension_nested_overlay");
		expect(opens).toHaveLength(1);
		expect(opens[0]).toMatchObject({ slot: "overlay" });
		const nestedId = opens[0]!.componentId as string;

		const mounts = ofType("overlay_mount");
		expect(mounts.at(-1)).toMatchObject({
			componentId: nestedId,
			mode: "modal",
		});
		const overlayId = mounts.at(-1)!.overlayId as string;
		expect(nested.ignoreTight).toBe(true);

		// Focus request for owned nested root.
		expect(ofType("component_focus_request").some(f => f.componentId === nestedId && f.focused === true)).toBe(true);

		// Temporary hide → overlay_unmount without disposing component.
		const disposeBeforeHide = ofType("component_dispose").length;
		handle.setHidden(true);
		expect(handle.isHidden()).toBe(true);
		expect(ofType("overlay_unmount").some(f => f.overlayId === overlayId)).toBe(true);
		expect(ofType("component_dispose").length).toBe(disposeBeforeHide);
		expect(nested.disposed).toBe(false);

		// Remount chrome.
		handle.setHidden(false);
		expect(handle.isHidden()).toBe(false);
		const remounts = ofType("overlay_mount").filter(f => f.overlayId === overlayId);
		expect(remounts.length).toBeGreaterThanOrEqual(2);

		// Permanent hide once.
		const unmountBefore = ofType("overlay_unmount").length;
		const disposeBefore = ofType("component_dispose").length;
		handle.hide();
		expect(nested.disposed).toBe(true);
		expect(ofType("overlay_unmount").length).toBe(unmountBefore + 1);
		expect(ofType("component_dispose").length).toBe(disposeBefore + 1);
		expect(ofType("component_dispose").at(-1)).toMatchObject({ componentId: nestedId });

		// Idempotent: further hide/dispose emit nothing new.
		const n = frames.length;
		handle.hide();
		(handle as typeof handle & { dispose(): void }).dispose();
		handle.setHidden(true);
		expect(frames.length).toBe(n);
		expect(handle.isHidden()).toBe(true);
	});

	test("fullscreen option maps to alt_screen mode", () => {
		const { host, ofType } = captureHost();
		let tui: TUI | undefined;
		host.setHeaderFactory(t => {
			tui = t;
			return fakeComponent();
		});
		tui!.showOverlay(fakeComponent(), { fullscreen: true });
		expect(ofType("overlay_mount").at(-1)).toMatchObject({ mode: "alt_screen" });
	});

	test("serializes full geometry and evaluates visible with terminal dimensions", () => {
		const { host, ofType } = captureHost();
		let tui: TUI | undefined;
		host.setHeaderFactory(t => {
			tui = t;
			return fakeComponent();
		});

		const visibilityCalls: Array<[number, number]> = [];
		const handle = tui!.showOverlay(fakeComponent(), {
			width: "60%",
			minWidth: 24,
			maxHeight: 14,
			anchor: "top-right",
			offsetX: -2,
			offsetY: 3,
			row: "25%",
			col: 4,
			margin: { top: 1, right: 2, bottom: 3, left: 4 },
			fullscreen: false,
			visible: (termWidth, termHeight) => {
				visibilityCalls.push([termWidth, termHeight]);
				return termWidth >= 100;
			},
		});
		const mount = ofType("overlay_mount").at(-1)!;
		expect(mount).toMatchObject({
			mode: "modal",
			width: "60%",
			minWidth: 24,
			maxHeight: 14,
			anchor: "top-right",
			offsetX: -2,
			offsetY: 3,
			row: "25%",
			col: 4,
			margin: { top: 1, right: 2, bottom: 3, left: 4 },
			fullscreen: false,
		});
		expect("visible" in mount).toBe(false);
		const componentId = mount.componentId as string;

		host.handleIncoming({
			type: "component_render",
			id: "visible-small",
			componentId,
			width: 31,
			height: 4,
			terminalWidth: 80,
			terminalHeight: 20,
		});
		expect(visibilityCalls).toEqual([[80, 20]]);
		expect(ofType("overlay_update").at(-1)).toMatchObject({ mode: "hidden" });

		const updatesAfterHide = ofType("overlay_update").length;
		host.handleIncoming({
			type: "component_render",
			id: "visible-same",
			componentId,
			width: 31,
			height: 4,
			terminalWidth: 80,
			terminalHeight: 20,
		});
		expect(ofType("overlay_update")).toHaveLength(updatesAfterHide);

		host.handleIncoming({
			type: "component_render",
			id: "visible-large",
			componentId,
			width: 31,
			height: 4,
			terminalWidth: 120,
			terminalHeight: 40,
		});
		expect(visibilityCalls.at(-1)).toEqual([120, 40]);
		expect(ofType("overlay_update").at(-1)).toMatchObject({ mode: "modal" });

		handle.setHidden(true);
		handle.setHidden(false);
		expect(ofType("overlay_mount").at(-1)).toMatchObject({
			width: "60%",
			anchor: "top-right",
			margin: { top: 1, right: 2, bottom: 3, left: 4 },
		});
	});
});

describe("RpcRemoteUiHost owned-only focus", () => {
	test("requestFocus emits focus_request only for owned components", () => {
		const { host, ofType } = captureHost();
		const owned = fakeComponent();
		let tui: TUI | undefined;
		host.setFooterFactory(t => {
			tui = t;
			return owned;
		});
		const ownedId = openId(ofType("component_open"));

		tui!.setFocus(owned);
		expect(ofType("component_focus_request")).toEqual([
			expect.objectContaining({
				type: "component_focus_request",
				componentId: ownedId,
				focused: true,
			}),
		]);
		expect(host.getFocusedComponent()).toBe(owned);

		const stranger = fakeComponent();
		const n = ofType("component_focus_request").length;
		tui!.setFocus(stranger as Component);
		expect(ofType("component_focus_request").length).toBe(n);
		expect(host.findComponentId(stranger as Component)).toBeUndefined();

		// Host confirms focus.
		host.handleIncoming({ type: "component_focus", componentId: ownedId, focused: true });
		expect(owned.focused).toBe(true);

		tui!.setFocus(null);
		expect(ofType("component_focus_request").at(-1)).toMatchObject({
			componentId: ownedId,
			focused: false,
		});
		expect(host.getFocusedComponent()).toBeNull();
	});
});

describe("RpcRemoteUiHost working/editor/tools sync", () => {
	test("working_message set and clear frames", () => {
		const { host, ofType } = captureHost();
		host.emitWorkingMessage("thinking");
		expect(ofType("working_message")[0]).toMatchObject({
			v: RPC_FRONTEND_PROTOCOL_V,
			type: "working_message",
			message: "thinking",
		});
		host.emitWorkingMessage("");
		expect(ofType("working_message")[1]).toMatchObject({
			type: "working_message",
			clear: true,
		});
		// Host→Bun working_message claimed but ignored as source is Bun.
		expect(host.handleIncoming({ type: "working_message", message: "x" })).toBe(true);
	});

	test("editor_update/query keep local cache and reply editor_state", () => {
		const { host, ofType } = captureHost();
		let editorText = "";
		host.setEditorComponentFactory(() => {
			const ed = fakeComponent({
				getText: () => editorText,
				setText: (t: string) => {
					editorText = t;
				},
			});
			return ed as never;
		});
		expect(ofType("component_open")[0]).toMatchObject({
			slot: "editor",
			kind: "extension_editor",
		});

		host.handleIncoming({
			type: "editor_update",
			id: "e1",
			op: "set_text",
			text: "hello",
			cursor: 2,
		});
		expect(host.getEditorTextSync()).toBe("hello");
		expect(ofType("editor_state")[0]).toMatchObject({
			id: "e1",
			text: "hello",
			cursor: 2,
		});
		expect(editorText).toBe("hello");

		host.handleIncoming({ type: "editor_update", op: "paste", text: "!" });
		// cursor was 2 → "he" + "!" + "llo"
		expect(host.getEditorTextSync()).toBe("he!llo");

		host.handleIncoming({ type: "editor_update", op: "set_cursor", cursor: 1 });
		host.handleIncoming({ type: "editor_query", id: "q1" });
		expect(ofType("editor_state").at(-1)).toMatchObject({
			id: "q1",
			text: "he!llo",
			cursor: 1,
		});

		host.handleIncoming({ type: "editor_update", id: "c1", op: "clear" });
		expect(host.getEditorTextSync()).toBe("");
		expect(ofType("editor_state").at(-1)).toMatchObject({ id: "c1", text: "", cursor: 0 });
	});

	test("tools_expanded push and query round-trip", () => {
		const { host, ofType } = captureHost();
		expect(host.toolsExpanded).toBe(false);
		host.setToolsExpanded(true);
		host.emitToolsExpanded("t1");
		expect(ofType("tools_expanded")[0]).toMatchObject({
			type: "tools_expanded",
			id: "t1",
			expanded: true,
		});

		host.handleIncoming({ type: "tools_expanded", expanded: false });
		expect(host.toolsExpanded).toBe(false);

		host.handleIncoming({ type: "tools_expanded", query: true, id: "tq" });
		expect(ofType("tools_expanded").at(-1)).toMatchObject({
			id: "tq",
			expanded: false,
		});
	});

	test("theme_query is not handled here (rpc-mode seam)", () => {
		const { host, frames } = captureHost();
		// Host claims non-remote-ui by returning false so rpc-mode can emit theme_sync.
		expect(host.handleIncoming({ type: "theme_query", id: "th1" })).toBe(false);
		expect(frames.filter(f => f.type === "theme_sync")).toHaveLength(0);
	});
});

test("builds a complete resolved theme_sync frame", () => {
	const frame = buildThemeSyncFrame("dark", "theme-query-1");
	expect(frame).toMatchObject({
		v: RPC_FRONTEND_PROTOCOL_V,
		type: "theme_sync",
		id: "theme-query-1",
		name: "dark",
		appearance: "dark",
	});
	expect(Object.keys(frame.palette ?? {}).sort()).toEqual([
		"accent",
		"border",
		"code",
		"dim",
		"error",
		"muted",
		"success",
		"text",
		"thinking",
		"user",
		"warning",
	]);
	for (const color of Object.values(frame.palette ?? {})) {
		expect(color).toMatch(/^#[0-9a-f]{6}$/i);
	}
});

describe("RpcRemoteUiHost disposeAll cleanup", () => {
	test("disposeAll tears down components silently and is idempotent", () => {
		const { host, ofType, frames } = captureHost();
		const a = fakeComponent();
		const b = fakeComponent();
		host.setFooterFactory(() => a);
		host.setHeaderFactory(() => b);
		expect(ofType("component_open").length).toBe(2);

		// No host-driven dispose yet (only opens).
		expect(ofType("component_dispose")).toHaveLength(0);

		host.disposeAll("bye");
		// silent teardown: no component_dispose frames after disposeAll
		expect(ofType("component_dispose")).toHaveLength(0);
		expect(a.disposed).toBe(true);
		expect(b.disposed).toBe(true);

		const after = frames.length;
		host.disposeAll("bye-again");
		expect(frames.length).toBe(after);

		// Post-dispose factory rejects.
		expect(() => host.setFooterFactory(() => fakeComponent())).toThrow(/shut down/i);
	});

	test("requestRender marks dirty and may emit invalidate", () => {
		const { host, ofType } = captureHost();
		let tui: TUI | undefined;
		host.setFooterFactory(t => {
			tui = t;
			return fakeComponent();
		});
		const id = openId(ofType("component_open"));
		tui!.requestRender();
		expect(ofType("component_invalidate").some(f => f.componentId === id)).toBe(true);
	});
});

describe("linesToComponent", () => {
	test("builds component from lines under max without theme truncation path", () => {
		// Truncation path calls theme.fg; keep under maxLines so this unit stays
		// free of global theme init (rpc-mode wires theme before linesToComponent).
		const c = linesToComponent(["alpha", "beta", "gamma"], 10);
		const rendered = c.render(40) as string[];
		expect(rendered.length).toBe(3);
		expect(rendered[0]).toContain("alpha");
		expect(rendered[2]).toContain("gamma");
	});
});

describe("RpcRemoteUiHost handleIncoming claim surface", () => {
	test("unknown types return false; remote types return true", () => {
		const { host } = captureHost();
		expect(host.handleIncoming(null)).toBe(false);
		expect(host.handleIncoming({ type: "prompt" })).toBe(false);
		expect(host.handleIncoming({ type: "component_open" })).toBe(true);
		expect(host.handleIncoming({ type: "terminal_input_subscription", active: true })).toBe(true);
		expect(host.handleIncoming({ type: "component_focus_request", componentId: "x" })).toBe(true);
	});
});
