/**
 * Remote UI host for RPC mode.
 *
 * Holds extension component factories/instances on the Bun side and speaks the
 * additive Go ompui/protocol remote-component + editor/working frames over the
 * existing bare JSONL RPC channel. Bun never owns a real TTY — it only renders
 * ANSI row arrays into JSON strings for the host to paint.
 */
import type { Component, OverlayHandle, TUI } from "@oh-my-pi/pi-tui";
import { Container, CURSOR_MARKER, Text, visibleWidth } from "@oh-my-pi/pi-tui";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { KeybindingsManager } from "../../config/keybindings";
import type { CustomEditor } from "../components/custom-editor";
import { getEditorTheme, type Theme, theme } from "../theme/theme";
import type {
	RpcComponentDisposeFrame,
	RpcComponentFocusFrame,
	RpcComponentFocusRequestFrame,
	RpcComponentInputFrame,
	RpcComponentInputResultFrame,
	RpcComponentInvalidateFrame,
	RpcComponentOpenFrame,
	RpcComponentRenderFrame,
	RpcComponentResultFrame,
	RpcComponentSlot,
	RpcEditorQueryFrame,
	RpcEditorStateFrame,
	RpcEditorUpdateFrame,
	RpcOverlayAnchor,
	RpcOverlayMargin,
	RpcOverlayMountFrame,
	RpcOverlaySizeValue,
	RpcOverlayUnmountFrame,
	RpcOverlayUpdateFrame,
	RpcTerminalInputFrame,
	RpcTerminalInputResultFrame,
	RpcTerminalInputSubscriptionFrame,
	RpcThemeSyncFrame,
	RpcToolsExpandedFrame,
	RpcWorkingMessageFrame,
} from "./rpc-types";
import { RPC_FRONTEND_PROTOCOL_V } from "./rpc-types";

export { RPC_FRONTEND_PROTOCOL_V };

export const RPC_REMOTE_UI_BOUNDS = {
	/** Hard cap on live remote component instances. */
	maxComponents: 64,
	/** Max accepted render width (cells). */
	maxRenderWidth: 512,
	/** Max rows returned from a single render. */
	maxRenderRows: 256,
	/** Max UTF-16 code units per rendered line. */
	maxLineChars: 4096,
	/** Max total characters across all lines in one result. */
	maxResultChars: 256 * 1024,
	/** Max raw input text/bytes accepted per input frame. */
	maxInputChars: 64 * 1024,
	/** Max editor text retained in the sync cache. */
	maxEditorTextChars: 1024 * 1024,
	/**
	 * Max terminal_input payload / result data characters (64 KiB).
	 * Same bound as component input — host must not flood JSONL.
	 */
	maxTerminalInputChars: 64 * 1024,
	/** Cap on remembered terminal_input ids to drop stale/duplicate replies. */
	maxTerminalInputSeenIds: 256,
} as const;

type Disposables = Component & {
	dispose?(): void;
	handleInput?(data: string): void;
	invalidate?(): void;
	wantsKeyRelease?: boolean;
	focused?: boolean;
	setUseTerminalCursor?(use: boolean): void;
	setIgnoreTight?(ignore: boolean): unknown;
	routeMouse?(
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
	): void;
	getText?(): string;
	setText?(text: string): void;
	getCursor?(): { line: number; col: number };
};

type PendingCustom = {
	componentId: string;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	closed: boolean;
};

type SlotEntry = {
	componentId: string;
	/** Widget map key when slot is widget_above/below. */
	key?: string;
};

export type RpcRemoteUiOutput = (
	frame:
		| RpcComponentOpenFrame
		| RpcComponentResultFrame
		| RpcComponentInvalidateFrame
		| RpcComponentInputResultFrame
		| RpcWorkingMessageFrame
		| RpcEditorStateFrame
		| RpcOverlayMountFrame
		| RpcOverlayUpdateFrame
		| RpcOverlayUnmountFrame
		| RpcComponentFocusRequestFrame
		| RpcTerminalInputSubscriptionFrame
		| RpcTerminalInputResultFrame
		| RpcThemeSyncFrame
		| RpcToolsExpandedFrame
		| object,
) => void;

/** Extension terminal-input listener (matches ExtensionUIContext / TUI InputListener). */
export type RpcTerminalInputHandler = (data: string) => { consume?: boolean; data?: string } | undefined;

type RegisteredComponent = {
	id: string;
	slot: RpcComponentSlot;
	kind: string;
	key?: string;
	component: Disposables;
	focused: boolean;
	dirty: boolean;
	disposed: boolean;
	overlayId?: string;
	/** When set, dispose resolves/rejects this custom() waiter. */
	pendingCustom?: PendingCustom;
};

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function clampInt(n: number, min: number, max: number): number {
	if (!Number.isFinite(n)) return min;
	return Math.max(min, Math.min(max, Math.trunc(n)));
}

const OVERLAY_ANCHORS = new Set<RpcOverlayAnchor>([
	"center",
	"top-left",
	"top-right",
	"bottom-left",
	"bottom-right",
	"top-center",
	"bottom-center",
	"left-center",
	"right-center",
]);

/** Serializable OverlayOptions fields only — never functions/source. */
type NestedOverlayWireOptions = {
	width?: RpcOverlaySizeValue;
	minWidth?: number;
	maxHeight?: RpcOverlaySizeValue;
	anchor?: RpcOverlayAnchor;
	offsetX?: number;
	offsetY?: number;
	row?: RpcOverlaySizeValue;
	col?: RpcOverlaySizeValue;
	margin?: RpcOverlayMargin;
	fullscreen?: boolean;
	mode?: RpcOverlayMountFrame["mode"];
};

function sanitizeOverlaySize(value: unknown): RpcOverlaySizeValue | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return Math.trunc(value);
	}
	if (typeof value === "string") {
		const s = value.trim();
		if (/^\d+(\.\d+)?%$/.test(s)) return s;
		if (/^-?\d+$/.test(s)) {
			const n = Number(s);
			if (Number.isFinite(n)) return Math.trunc(n);
		}
	}
	return undefined;
}

function sanitizeOverlayInt(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
	if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
		const n = Number(value.trim());
		if (Number.isFinite(n)) return Math.trunc(n);
	}
	return undefined;
}

function sanitizeOverlayAnchor(value: unknown): RpcOverlayAnchor | undefined {
	if (typeof value !== "string") return undefined;
	const a = value.trim() as RpcOverlayAnchor;
	return OVERLAY_ANCHORS.has(a) ? a : undefined;
}

function sanitizeOverlayMargin(value: unknown): RpcOverlayMargin | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return Math.trunc(value);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const src = value as Record<string, unknown>;
	const out: { top?: number; right?: number; bottom?: number; left?: number } = {};
	let any = false;
	for (const key of ["top", "right", "bottom", "left"] as const) {
		const n = sanitizeOverlayInt(src[key]);
		if (n !== undefined) {
			out[key] = n;
			any = true;
		}
	}
	return any ? out : undefined;
}

/**
 * Copy only serializable OverlayOptions primitives for the JSON bridge.
 * Drops `visible` (kept as a local callback) and any function/source values.
 */
function sanitizeNestedOverlayOptions(options: unknown): {
	wire: NestedOverlayWireOptions;
	visible?: (termWidth: number, termHeight: number) => boolean;
} {
	const wire: NestedOverlayWireOptions = {};
	let visible: ((termWidth: number, termHeight: number) => boolean) | undefined;
	if (!options || typeof options !== "object" || Array.isArray(options)) {
		return { wire };
	}
	const src = options as Record<string, unknown>;

	const width = sanitizeOverlaySize(src.width);
	if (width !== undefined) wire.width = width;
	const minWidth = sanitizeOverlayInt(src.minWidth);
	if (minWidth !== undefined) wire.minWidth = minWidth;
	const maxHeight = sanitizeOverlaySize(src.maxHeight);
	if (maxHeight !== undefined) wire.maxHeight = maxHeight;
	const anchor = sanitizeOverlayAnchor(src.anchor);
	if (anchor !== undefined) wire.anchor = anchor;
	const offsetX = sanitizeOverlayInt(src.offsetX);
	if (offsetX !== undefined) wire.offsetX = offsetX;
	const offsetY = sanitizeOverlayInt(src.offsetY);
	if (offsetY !== undefined) wire.offsetY = offsetY;
	const row = sanitizeOverlaySize(src.row);
	if (row !== undefined) wire.row = row;
	const col = sanitizeOverlaySize(src.col);
	if (col !== undefined) wire.col = col;
	const margin = sanitizeOverlayMargin(src.margin);
	if (margin !== undefined) wire.margin = margin;
	if (src.fullscreen === true) wire.fullscreen = true;
	else if (src.fullscreen === false) wire.fullscreen = false;

	if (src.mode === "modal" || src.mode === "alt_screen" || src.mode === "inline") {
		wire.mode = src.mode;
	}

	if (typeof src.visible === "function") {
		visible = src.visible as (termWidth: number, termHeight: number) => boolean;
	}

	return { wire, visible };
}

function resolveNestedOverlayMode(wire: NestedOverlayWireOptions): RpcOverlayMountFrame["mode"] {
	if (wire.mode === "modal" || wire.mode === "alt_screen" || wire.mode === "inline") {
		return wire.mode;
	}
	if (wire.fullscreen === true) return "alt_screen";
	return "modal";
}

function buildOverlayMountFrame(
	overlayId: string,
	componentId: string,
	wire: NestedOverlayWireOptions,
): RpcOverlayMountFrame {
	const mode = resolveNestedOverlayMode(wire);
	const frame: RpcOverlayMountFrame = {
		v: RPC_FRONTEND_PROTOCOL_V,
		type: "overlay_mount",
		overlayId,
		componentId,
		mode,
	};
	if (wire.width !== undefined) frame.width = wire.width;
	if (wire.minWidth !== undefined) frame.minWidth = wire.minWidth;
	if (wire.maxHeight !== undefined) frame.maxHeight = wire.maxHeight;
	if (wire.anchor !== undefined) frame.anchor = wire.anchor;
	if (wire.offsetX !== undefined) frame.offsetX = wire.offsetX;
	if (wire.offsetY !== undefined) frame.offsetY = wire.offsetY;
	if (wire.row !== undefined) frame.row = wire.row;
	if (wire.col !== undefined) frame.col = wire.col;
	if (wire.margin !== undefined) frame.margin = wire.margin;
	if (wire.fullscreen === true || mode === "alt_screen") frame.fullscreen = true;
	else if (wire.fullscreen === false) frame.fullscreen = false;
	return frame;
}

function decodeInputBytes(data: unknown): string | undefined {
	if (typeof data === "string") {
		// Go may base64-encode binary Data; accept raw UTF-8 too.
		if (/^[A-Za-z0-9+/]+=*$/.test(data) && data.length % 4 === 0 && data.length > 0) {
			try {
				const decoded = Buffer.from(data, "base64").toString("utf8");
				if (decoded.length > 0) return decoded;
			} catch {
				// fall through
			}
		}
		return data;
	}
	if (Array.isArray(data)) {
		try {
			return Buffer.from(data as number[]).toString("utf8");
		} catch {
			return undefined;
		}
	}
	return undefined;
}

function extractCursor(lines: string[]): { lines: string[]; cursorCol?: number; cursorRow?: number } {
	let cursorCol: number | undefined;
	let cursorRow: number | undefined;
	const out = lines.map((line, row) => {
		let markerIndex = line.indexOf(CURSOR_MARKER);
		if (markerIndex === -1) return line;
		if (cursorRow === undefined) {
			cursorRow = row;
			cursorCol = visibleWidth(line.slice(0, markerIndex));
		}
		let stripped = line;
		while (markerIndex !== -1) {
			stripped = stripped.slice(0, markerIndex) + stripped.slice(markerIndex + CURSOR_MARKER.length);
			markerIndex = stripped.indexOf(CURSOR_MARKER, markerIndex);
		}
		return stripped;
	});
	return { lines: out, cursorCol, cursorRow };
}

function boundLines(lines: readonly string[]): { lines: string[]; truncated: boolean } {
	const maxRows = RPC_REMOTE_UI_BOUNDS.maxRenderRows;
	const maxLine = RPC_REMOTE_UI_BOUNDS.maxLineChars;
	const maxTotal = RPC_REMOTE_UI_BOUNDS.maxResultChars;
	const out: string[] = [];
	let total = 0;
	let truncated = false;
	const rowLimit = Math.min(lines.length, maxRows);
	if (lines.length > maxRows) truncated = true;
	for (let i = 0; i < rowLimit; i++) {
		let line = lines[i] ?? "";
		if (line.length > maxLine) {
			line = line.slice(0, maxLine);
			truncated = true;
		}
		if (total + line.length > maxTotal) {
			const remain = Math.max(0, maxTotal - total);
			if (remain > 0) out.push(line.slice(0, remain));
			truncated = true;
			break;
		}
		out.push(line);
		total += line.length;
	}
	return { lines: out, truncated };
}
/**
 * Headless TUI surface for extension factories.
 * No terminal ownership — requestRender only marks the bound component dirty
 * and may emit component_invalidate for the host to re-query.
 * Nested showOverlay mounts a real remote overlay component; setFocus only
 * requests focus for components this host owns.
 */
function createRemoteTui(host: RpcRemoteUiHost, ownerComponentId: string): TUI {
	const terminal = {
		columns: 80,
		rows: 24,
		get width() {
			return this.columns;
		},
		get height() {
			return this.rows;
		},
	};
	const tui = {
		terminal,
		requestRender: () => {
			host.markDirty(ownerComponentId, true);
		},
		requestComponentRender: (component?: Component) => {
			if (component && host.requestRenderForComponent(component)) return;
			host.markDirty(ownerComponentId, true);
		},
		setFocus: (component?: Component | null) => {
			host.requestFocus(component ?? null, ownerComponentId);
		},
		getFocused: () => host.getFocusedComponent(),
		getShowHardwareCursor: () => true,
		showOverlay: (component: Component, options?: unknown): OverlayHandle => {
			return host.mountNestedOverlay(component, ownerComponentId, options);
		},
		addChild: () => {},
		removeChild: () => {},
		addInputListener: (listener: RpcTerminalInputHandler) => host.addTerminalInputListener(listener),
		start: () => {},
		stop: () => {},
	};
	return tui as unknown as TUI;
}

type NestedOverlayEntry = {
	overlayId: string;
	componentId: string;
	ownerComponentId: string;
	component: Disposables;
	hidden: boolean;
	/** True after permanent hide/dispose — further hide/setHidden/dispose are no-ops. */
	closed: boolean;
	/** Lifecycle frames (unmount + dispose) emitted at most once. */
	lifecycleEmitted: boolean;
	/** Serializable OverlayOptions retained across hidden→visible remount. */
	wireOptions: NestedOverlayWireOptions;
	/** Resolved mount mode (modal/alt_screen/inline). */
	mode: RpcOverlayMountFrame["mode"];
	/** Local-only visibility gate; never serialized. */
	visible?: (termWidth: number, termHeight: number) => boolean;
	/**
	 * Last evaluated visible() result. undefined until first component_render eval.
	 * Used so we emit at most one overlay_update per visibility transition.
	 */
	lastVisible?: boolean;
};

export class RpcRemoteUiHost {
	#output: RpcRemoteUiOutput;
	#components = new Map<string, RegisteredComponent>();
	/** custom() factories not yet mounted; tracked so shutdown/error can settle them. */
	#pendingCustoms = new Map<string, PendingCustom>();
	/** Singleton slots (footer/header/editor) and widget keys → live id. */
	#slotIndex = new Map<string, SlotEntry>();
	#editorText = "";
	#editorCursor = 0;
	#toolsExpanded = false;
	#keybindings = KeybindingsManager.inMemory();
	#disposed = false;
	/** Ordered extension terminal-input listeners (registration order). */
	#terminalInputListeners: RpcTerminalInputHandler[] = [];
	/** Recently handled terminal_input ids (drop stale/duplicate). */
	#terminalInputSeenIds = new Set<string>();
	#terminalInputSeenOrder: string[] = [];
	/** Nested showOverlay mounts keyed by overlayId. */
	#nestedOverlays = new Map<string, NestedOverlayEntry>();
	/** Component currently believed focused (host-driven + local requests). */
	#focusedComponent: Component | null = null;

	constructor(output: RpcRemoteUiOutput) {
		this.#output = output;
	}

	/** Last-known editor buffer for synchronous getEditorText(). */
	get editorText(): string {
		return this.#editorText;
	}

	get toolsExpanded(): boolean {
		return this.#toolsExpanded;
	}

	setToolsExpanded(expanded: boolean): void {
		this.#toolsExpanded = expanded === true;
	}

	/** Emit tools_expanded snapshot for host cache sync. */
	emitToolsExpanded(id?: string): void {
		if (this.#disposed) return;
		const frame: RpcToolsExpandedFrame = {
			v: RPC_FRONTEND_PROTOCOL_V,
			type: "tools_expanded",
			id,
			expanded: this.#toolsExpanded,
		};
		this.#output(frame);
	}

	/**
	 * Synchronous editor text strategy:
	 * ExtensionUIContext.getEditorText() is sync and cannot await a host round-trip.
	 * We keep a local cache updated by setEditorText, editor_update, and editor_state
	 * replies. Callers that need a guaranteed-fresh value must use the async
	 * editor_query / editor_state frames (host-driven). Until the host pushes state,
	 * getEditorText returns "" or the last value this side set.
	 */
	getEditorTextSync(): string {
		return this.#editorText;
	}

	setEditorTextLocal(text: string): void {
		const next = typeof text === "string" ? text : String(text ?? "");
		this.#editorText =
			next.length > RPC_REMOTE_UI_BOUNDS.maxEditorTextChars
				? next.slice(0, RPC_REMOTE_UI_BOUNDS.maxEditorTextChars)
				: next;
		// Match Go SetText: replacement parks cursor at end. Callers that know a
		// cursor (editor_state / set_cursor) override on the next lines.
		this.#editorCursor = this.#editorText.length;
	}

	/** Splice text at the cached cursor and advance the cursor past the insert. */
	pasteEditorTextLocal(text: string): void {
		const insert = typeof text === "string" ? text : String(text ?? "");
		const at = clampInt(this.#editorCursor, 0, this.#editorText.length);
		const next = this.#editorText.slice(0, at) + insert + this.#editorText.slice(at);
		this.setEditorTextLocal(next);
		this.#editorCursor = Math.min(at + insert.length, this.#editorText.length);
	}

	/**
	 * Mark every live remote component dirty and emit component_invalidate so the
	 * host re-requests renders after a theme change.
	 */
	invalidateAll(): void {
		if (this.#disposed) return;
		for (const [componentId, entry] of this.#components) {
			if (!entry || entry.disposed) continue;
			entry.dirty = true;
			const frame: RpcComponentInvalidateFrame = {
				v: RPC_FRONTEND_PROTOCOL_V,
				type: "component_invalidate",
				componentId,
			};
			this.#output(frame);
		}
	}

	emitWorkingMessage(message?: string): void {
		if (this.#disposed) return;
		if (message === undefined || message === "") {
			const frame: RpcWorkingMessageFrame = {
				v: RPC_FRONTEND_PROTOCOL_V,
				type: "working_message",
				clear: true,
			};
			this.#output(frame);
			return;
		}
		const frame: RpcWorkingMessageFrame = {
			v: RPC_FRONTEND_PROTOCOL_V,
			type: "working_message",
			message: String(message),
		};
		this.#output(frame);
	}

	markDirty(componentId: string, emitInvalidate: boolean): void {
		const entry = this.#components.get(componentId);
		if (!entry || entry.disposed) return;
		entry.dirty = true;
		if (emitInvalidate) {
			const frame: RpcComponentInvalidateFrame = {
				v: RPC_FRONTEND_PROTOCOL_V,
				type: "component_invalidate",
				componentId,
			};
			this.#output(frame);
		}
	}

	// ---------------------------------------------------------------------------
	// Terminal input listeners (extension onTerminalInput → host forward)
	// ---------------------------------------------------------------------------

	/**
	 * Register an ordered terminal-input listener.
	 * Emits terminal_input_subscription only on 0→1 and 1→0 transitions.
	 * Returns unsubscribe; repeated unsubscribe is a no-op.
	 */
	addTerminalInputListener(handler: RpcTerminalInputHandler): () => void {
		if (typeof handler !== "function") return () => {};
		const before = this.#terminalInputListeners.length;
		this.#terminalInputListeners.push(handler);
		if (before === 0 && this.#terminalInputListeners.length === 1) {
			this.#emitTerminalInputSubscription(true);
		}
		let active = true;
		return () => {
			if (!active) return;
			active = false;
			const idx = this.#terminalInputListeners.indexOf(handler);
			if (idx === -1) return;
			this.#terminalInputListeners.splice(idx, 1);
			if (this.#terminalInputListeners.length === 0) {
				this.#emitTerminalInputSubscription(false);
			}
		};
	}

	/** True when at least one terminal-input listener is registered. */
	get hasTerminalInputListeners(): boolean {
		return this.#terminalInputListeners.length > 0;
	}

	/**
	 * Run listeners in registration order with TUI consume/data transform
	 * semantics. Per-listener exceptions are isolated. Synchronous — one
	 * request at a time in input-frame order.
	 */
	handleTerminalInput(frame: RpcTerminalInputFrame): void {
		const id = typeof frame.id === "string" ? frame.id : "";
		if (!id) {
			// No id → cannot correlate a result; drop silently (stale/malformed).
			return;
		}
		if (this.#terminalInputSeenIds.has(id)) {
			// Stale/duplicate id: emit a harmless already-consumed ack so the host
			// does not hang, but do not re-run listeners.
			this.#emitTerminalInputResult(id, true);
			return;
		}
		this.#rememberTerminalInputId(id);

		let text: string | undefined;
		if (typeof frame.text === "string" && frame.text.length > 0) {
			text = frame.text;
		} else if (frame.data !== undefined) {
			text = decodeInputBytes(frame.data);
		}
		if (text === undefined) {
			this.#emitTerminalInputResult(id, false, undefined, "missing data/text");
			return;
		}
		if (text.length > RPC_REMOTE_UI_BOUNDS.maxTerminalInputChars) {
			text = text.slice(0, RPC_REMOTE_UI_BOUNDS.maxTerminalInputChars);
		}

		if (this.#terminalInputListeners.length === 0) {
			// No listeners: still ack so host does not hang, but do not claim consume.
			this.#emitTerminalInputResult(id, false, text);
			return;
		}

		let current = text;
		let consumed = false;
		let firstError: string | undefined;

		// Snapshot so unsubscribe mid-dispatch does not skip/double-fire.
		const listeners = this.#terminalInputListeners.slice();
		for (const listener of listeners) {
			try {
				const result = listener(current);
				if (result?.consume) {
					consumed = true;
					break;
				}
				if (result?.data !== undefined) {
					current =
						result.data.length > RPC_REMOTE_UI_BOUNDS.maxTerminalInputChars
							? result.data.slice(0, RPC_REMOTE_UI_BOUNDS.maxTerminalInputChars)
							: result.data;
					if (current.length === 0) {
						// Empty transform drops remaining pipeline like TUI.
						consumed = true;
						break;
					}
				}
			} catch (err) {
				// Isolate per-listener exceptions so one throw does not corrupt JSONL
				// or abort the remaining chain / result emit.
				if (firstError === undefined) firstError = errorMessage(err);
			}
		}

		if (consumed) {
			this.#emitTerminalInputResult(id, true, undefined, firstError);
			return;
		}
		this.#emitTerminalInputResult(id, false, current, firstError);
	}

	// ---------------------------------------------------------------------------
	// Focus + nested overlay (headless TUI surface)
	// ---------------------------------------------------------------------------

	getFocusedComponent(): Component | null {
		return this.#focusedComponent;
	}

	/**
	 * Resolve a Component instance to its registered remote id, if any.
	 * Used so setFocus cannot target arbitrary objects the host does not own.
	 */
	findComponentId(component: Component | null | undefined): string | undefined {
		if (!component) return undefined;
		for (const entry of this.#components.values()) {
			if (!entry.disposed && entry.component === component) return entry.id;
		}
		return undefined;
	}

	/** Mark dirty + invalidate when the component is one we own. */
	requestRenderForComponent(component: Component): boolean {
		const id = this.findComponentId(component);
		if (!id) return false;
		this.markDirty(id, true);
		return true;
	}

	/**
	 * setFocus from a remote TUI: only request focus for a component this host
	 * owns. Arbitrary objects are ignored. Emits component_focus_request.
	 */
	requestFocus(component: Component | null, ownerComponentId?: string): void {
		if (this.#disposed) return;
		if (component == null) {
			// Clearing focus: if we know a focused owned component, ask host to unfocus it.
			const prev = this.#focusedComponent;
			const prevId = this.findComponentId(prev);
			this.#focusedComponent = null;
			if (prevId) {
				const entry = this.#components.get(prevId);
				if (entry && !entry.disposed) {
					entry.focused = false;
					try {
						if (typeof entry.component.focused === "boolean" || "focused" in entry.component) {
							entry.component.focused = false;
						}
					} catch {
						// ignore
					}
					const frame: RpcComponentFocusRequestFrame = {
						v: RPC_FRONTEND_PROTOCOL_V,
						type: "component_focus_request",
						componentId: prevId,
						focused: false,
					};
					this.#output(frame);
				}
			}
			return;
		}

		let targetId = this.findComponentId(component);
		// Nested overlay roots are owned; also accept the calling factory's own id.
		if (!targetId && ownerComponentId) {
			const owner = this.#components.get(ownerComponentId);
			if (owner && !owner.disposed && owner.component === component) {
				targetId = ownerComponentId;
			}
		}
		if (!targetId) {
			// Do not focus arbitrary objects the host has no session for.
			return;
		}
		const entry = this.#components.get(targetId);
		if (!entry || entry.disposed) return;

		// Local bookkeeping (host will confirm via component_focus).
		if (this.#focusedComponent && this.#focusedComponent !== component) {
			const prevId = this.findComponentId(this.#focusedComponent);
			if (prevId) {
				const prev = this.#components.get(prevId);
				if (prev && !prev.disposed) {
					prev.focused = false;
					try {
						if (typeof prev.component.focused === "boolean" || "focused" in prev.component) {
							prev.component.focused = false;
						}
					} catch {
						// ignore
					}
				}
			}
		}
		this.#focusedComponent = component;
		entry.focused = true;
		try {
			if (typeof entry.component.focused === "boolean" || "focused" in entry.component) {
				entry.component.focused = true;
			}
			entry.component.setUseTerminalCursor?.(true);
		} catch {
			// ignore
		}

		const frame: RpcComponentFocusRequestFrame = {
			v: RPC_FRONTEND_PROTOCOL_V,
			type: "component_focus_request",
			componentId: targetId,
			focused: true,
		};
		this.#output(frame);
	}

	/**
	 * Mount a nested Component as a real remote overlay.
	 * hide/setHidden(true-permanent via hide)/dispose emit overlay_unmount +
	 * component_dispose exactly once. setHidden toggles host visibility without
	 * disposing until hide/dispose.
	 */
	mountNestedOverlay(
		component: Component,
		ownerComponentId: string,
		options?: unknown,
	): OverlayHandle & { dispose(): void } {
		const emptyHandle = (): OverlayHandle & { dispose(): void } => {
			let hidden = true;
			return {
				hide: () => {
					hidden = true;
				},
				setHidden: (h: boolean) => {
					hidden = h;
				},
				isHidden: () => hidden,
				dispose: () => {
					hidden = true;
				},
			};
		};

		if (this.#disposed || !component) return emptyHandle();
		if (this.#components.size >= RPC_REMOTE_UI_BOUNDS.maxComponents) {
			return emptyHandle();
		}

		const componentId = Snowflake.next() as string;
		const overlayId = Snowflake.next() as string;
		const disposables = component as Disposables;

		try {
			disposables.setIgnoreTight?.(true);
		} catch {
			// ignore
		}

		const entry: RegisteredComponent = {
			id: componentId,
			slot: "overlay",
			kind: "extension_nested_overlay",
			component: disposables,
			focused: false,
			dirty: true,
			disposed: false,
			overlayId,
		};
		this.#components.set(componentId, entry);

		const { wire, visible } = sanitizeNestedOverlayOptions(options);
		const mode = resolveNestedOverlayMode(wire);
		const nested: NestedOverlayEntry = {
			overlayId,
			componentId,
			ownerComponentId,
			component: disposables,
			hidden: false,
			closed: false,
			lifecycleEmitted: false,
			wireOptions: wire,
			mode,
			visible,
			lastVisible: undefined,
		};
		this.#nestedOverlays.set(overlayId, nested);

		this.#emitOpen(entry);

		const mount = buildOverlayMountFrame(overlayId, componentId, wire);
		this.#output(mount);

		// Focus the nested overlay root (owned component).
		this.requestFocus(disposables, ownerComponentId);

		const closeOnce = () => {
			if (nested.closed) return;
			nested.closed = true;
			nested.hidden = true;
			this.#nestedOverlays.delete(overlayId);
			// #disposeComponent emits overlay_unmount + component_dispose once.
			this.#disposeComponent(componentId, {
				settleCustom: { ok: true, value: undefined },
			});
			nested.lifecycleEmitted = true;
		};

		return {
			hide: () => {
				closeOnce();
			},
			setHidden: (hidden: boolean) => {
				if (nested.closed) return;
				if (nested.hidden === hidden) return;
				nested.hidden = hidden;
				if (hidden) {
					// Temporary hide: unmount chrome but keep component until hide/dispose.
					// Emit overlay_unmount without disposing the component so setHidden(false)
					// can remount. Focus falls back to owner.
					if (!this.#disposed) {
						const unmount: RpcOverlayUnmountFrame = {
							v: RPC_FRONTEND_PROTOCOL_V,
							type: "overlay_unmount",
							overlayId,
						};
						this.#output(unmount);
					}
					if (this.#focusedComponent === disposables) {
						const owner = this.#components.get(ownerComponentId);
						this.requestFocus(owner?.component ?? null, ownerComponentId);
					}
					entry.dirty = true;
				} else {
					// Remount overlay chrome with the same sanitized options.
					const remount = buildOverlayMountFrame(overlayId, componentId, nested.wireOptions);
					this.#output(remount);
					// Fresh visibility eval on next component_render.
					nested.lastVisible = undefined;
					this.requestFocus(disposables, ownerComponentId);
					entry.dirty = true;
					this.markDirty(componentId, true);
				}
			},
			isHidden: () => nested.hidden || nested.closed,
			dispose: () => {
				closeOnce();
			},
		};
	}

	// ---------------------------------------------------------------------------
	// Factory registration (extension → host)
	// ---------------------------------------------------------------------------

	setWidgetFactory(
		key: string,
		factory: ((tui: TUI, theme: Theme) => Disposables) | undefined,
		placement: "aboveEditor" | "belowEditor" = "aboveEditor",
	): void {
		const slot: RpcComponentSlot = placement === "belowEditor" ? "widget_below" : "widget_above";
		// Interactive mode removes the key from both placements before mounting.
		const aboveKey = `widget:widget_above:${key}`;
		const belowKey = `widget:widget_below:${key}`;
		const prevAbove = this.#slotIndex.get(aboveKey);
		if (prevAbove) {
			this.#disposeComponent(prevAbove.componentId);
			this.#slotIndex.delete(aboveKey);
		}
		const prevBelow = this.#slotIndex.get(belowKey);
		if (prevBelow) {
			this.#disposeComponent(prevBelow.componentId);
			this.#slotIndex.delete(belowKey);
		}
		if (!factory) return;
		const indexKey = `widget:${slot}:${key}`;
		const id = this.#mountFactory({
			slot,
			kind: "extension_widget",
			key,
			create: cid => factory(createRemoteTui(this, cid), theme),
		});
		const entry = this.#components.get(id);
		if (entry) {
			this.#slotIndex.set(indexKey, { componentId: id, key: entry.key });
		}
	}

	setFooterFactory(factory: ((tui: TUI, theme: Theme) => Disposables) | undefined): void {
		this.#replaceSlot("footer", () => {
			if (!factory) return undefined;
			return this.#mountFactory({
				slot: "footer",
				kind: "extension_footer",
				create: id => factory(createRemoteTui(this, id), theme),
			});
		});
	}

	setHeaderFactory(factory: ((tui: TUI, theme: Theme) => Disposables) | undefined): void {
		this.#replaceSlot("header", () => {
			if (!factory) return undefined;
			return this.#mountFactory({
				slot: "header",
				kind: "extension_header",
				create: id => factory(createRemoteTui(this, id), theme),
			});
		});
	}

	setEditorComponentFactory(
		factory:
			| ((tui: TUI, theme: ReturnType<typeof getEditorTheme>, keybindings: KeybindingsManager) => CustomEditor)
			| undefined,
	): void {
		this.#replaceSlot("editor", () => {
			if (!factory) return undefined;
			return this.#mountFactory({
				slot: "editor",
				kind: "extension_editor",
				create: id => {
					const editor = factory(createRemoteTui(this, id), getEditorTheme(), this.#keybindings);
					editor.setUseTerminalCursor?.(true);
					if (this.#editorText && typeof editor.setText === "function") {
						try {
							editor.setText(this.#editorText);
						} catch {
							// ignore seed failures
						}
					}
					return editor;
				},
			});
		});
	}

	/**
	 * Mount a custom() extension surface. Resolves when the factory calls done()
	 * or when the component is disposed/cancelled.
	 */
	mountCustom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => Disposables | Promise<Disposables>,
		options?: { overlay?: boolean },
	): Promise<T> {
		if (this.#disposed) {
			return Promise.resolve(undefined as T);
		}
		if (this.#components.size + this.#pendingCustoms.size >= RPC_REMOTE_UI_BOUNDS.maxComponents) {
			return Promise.reject(new Error(`Remote component limit reached (${RPC_REMOTE_UI_BOUNDS.maxComponents})`));
		}

		const componentId = Snowflake.next() as string;
		const { promise, resolve, reject } = Promise.withResolvers<T>();
		const pending: PendingCustom = {
			componentId,
			resolve: value => resolve(value as T),
			reject,
			closed: false,
		};
		this.#pendingCustoms.set(componentId, pending);

		const settleBeforeMount = (result: { ok: true; value: T } | { ok: false; error: Error }) => {
			if (pending.closed) return;
			pending.closed = true;
			this.#pendingCustoms.delete(componentId);
			if (result.ok) pending.resolve(result.value);
			else pending.reject(result.error);
		};
		const done = (result: T) => {
			const entry = this.#components.get(componentId);
			if (entry && !entry.disposed) {
				this.#disposeComponent(componentId, { settleCustom: { ok: true, value: result } });
				return;
			}
			settleBeforeMount({ ok: true, value: result });
		};

		let created: Promise<Disposables>;
		try {
			created = Promise.resolve(factory(createRemoteTui(this, componentId), theme, this.#keybindings, done));
		} catch (err) {
			settleBeforeMount({
				ok: false,
				error: err instanceof Error ? err : new Error(errorMessage(err)),
			});
			return promise;
		}

		void created
			.then(component => {
				if (pending.closed || this.#disposed) {
					try {
						component?.dispose?.();
					} catch {
						// ignore late factory disposal errors
					}
					return;
				}
				if (!component || typeof component.render !== "function") {
					throw new Error("custom() factory returned an invalid component");
				}

				this.#pendingCustoms.delete(componentId);
				const slot: RpcComponentSlot = options?.overlay ? "overlay" : "custom";
				const overlayId = options?.overlay ? (Snowflake.next() as string) : undefined;
				const entry: RegisteredComponent = {
					id: componentId,
					slot,
					kind: "extension_custom",
					component,
					focused: false,
					dirty: true,
					disposed: false,
					overlayId,
					pendingCustom: pending,
				};
				this.#components.set(componentId, entry);

				this.#emitOpen(entry);
				if (overlayId) {
					const mount: RpcOverlayMountFrame = {
						v: RPC_FRONTEND_PROTOCOL_V,
						type: "overlay_mount",
						overlayId,
						componentId,
						mode: "modal",
					};
					this.#output(mount);
				}
			})
			.catch(err => {
				const error = err instanceof Error ? err : new Error(errorMessage(err));
				const entry = this.#components.get(componentId);
				if (entry && !entry.disposed) {
					this.#disposeComponent(componentId, {
						settleCustom: { ok: false, error },
						silent: true,
					});
				} else {
					settleBeforeMount({ ok: false, error });
				}
			});

		return promise;
	}

	// ---------------------------------------------------------------------------
	// Host → Bun request handlers
	// ---------------------------------------------------------------------------

	/** Returns true when the frame was a remote-ui frame (handled or rejected). */
	handleIncoming(parsed: unknown): boolean {
		if (!parsed || typeof parsed !== "object") return false;
		const frame = parsed as { type?: unknown };
		switch (frame.type) {
			case "component_render":
				this.#handleRender(frame as RpcComponentRenderFrame);
				return true;
			case "component_input":
				this.#handleInput(frame as RpcComponentInputFrame);
				return true;
			case "component_dispose":
				this.#handleDispose(frame as RpcComponentDisposeFrame, true);
				return true;
			case "component_focus":
				this.#handleFocus(frame as RpcComponentFocusFrame);
				return true;
			case "component_open":
				// Host-initiated open is not used; Bun opens. Acknowledge by ignoring.
				return true;
			case "component_invalidate": {
				const id = (frame as RpcComponentInvalidateFrame).componentId;
				const entry = typeof id === "string" ? this.#components.get(id) : undefined;
				if (entry && !entry.disposed) {
					entry.dirty = true;
					try {
						entry.component.invalidate?.();
					} catch {
						// ignore
					}
				}
				return true;
			}
			case "editor_query":
				this.#handleEditorQuery(frame as RpcEditorQueryFrame);
				return true;
			case "editor_update":
				this.#handleEditorUpdate(frame as RpcEditorUpdateFrame);
				return true;
			case "editor_state": {
				const state = frame as RpcEditorStateFrame;
				if (typeof state.text === "string") {
					this.setEditorTextLocal(state.text);
					if (typeof state.cursor === "number" && Number.isFinite(state.cursor)) {
						this.#editorCursor = clampInt(state.cursor, 0, this.#editorText.length);
					}
				}
				return true;
			}
			case "working_message":
				// Host→Bun working message is ignored (Bun is the source).
				return true;
			case "overlay_unmount": {
				const overlayId = (frame as RpcOverlayUnmountFrame).overlayId;
				if (typeof overlayId === "string") {
					const nested = this.#nestedOverlays.get(overlayId);
					if (nested) {
						nested.closed = true;
						nested.hidden = true;
						this.#nestedOverlays.delete(overlayId);
					}
					for (const entry of this.#components.values()) {
						if (entry.overlayId === overlayId) {
							this.#disposeComponent(entry.id, {
								settleCustom: { ok: true, value: undefined },
								silent: true,
							});
							break;
						}
					}
				}
				return true;
			}
			case "terminal_input":
				// Process synchronously in input-frame order (no queue / pending map).
				this.handleTerminalInput(frame as RpcTerminalInputFrame);
				return true;
			case "tools_expanded": {
				const tools = frame as RpcToolsExpandedFrame;
				if (tools.query === true) {
					this.emitToolsExpanded(typeof tools.id === "string" ? tools.id : undefined);
					return true;
				}
				if (typeof tools.expanded === "boolean") {
					this.setToolsExpanded(tools.expanded);
				}
				return true;
			}
			case "theme_query":
				// Handled in rpc-mode (needs getCurrentThemeName). Claim the frame
				// type so RpcCommand does not see it; rpc-mode peeks first.
				return false;
			case "component_focus_request":
			case "terminal_input_subscription":
			case "terminal_input_result":
			case "theme_sync":
				// Outbound-only types if echoed by a confused peer — ignore safely.
				return true;
			default:
				return false;
		}
	}

	/** Tear down every component and pending custom() waiter. */
	disposeAll(reason = "RPC remote UI shutdown"): void {
		if (this.#disposed) return;
		this.#disposed = true;
		const hadListeners = this.#terminalInputListeners.length > 0;
		this.#terminalInputListeners = [];
		this.#nestedOverlays.clear();
		this.#focusedComponent = null;
		this.#terminalInputSeenIds.clear();
		this.#terminalInputSeenOrder = [];
		for (const pending of this.#pendingCustoms.values()) {
			if (pending.closed) continue;
			pending.closed = true;
			pending.reject(new Error(reason));
		}
		this.#pendingCustoms.clear();
		const ids = Array.from(this.#components.keys());
		for (const id of ids) {
			this.#disposeComponent(id, {
				settleCustom: { ok: false, error: new Error(reason) },
				silent: true,
			});
		}
		this.#components.clear();
		this.#slotIndex.clear();
		// Emit 1→0 subscription transition so host stops key forwarding.
		if (hadListeners) {
			// #disposed is true — emit via raw output still (host may be shutting too).
			const frame: RpcTerminalInputSubscriptionFrame = {
				v: RPC_FRONTEND_PROTOCOL_V,
				type: "terminal_input_subscription",
				active: false,
			};
			try {
				this.#output(frame);
			} catch {
				// ignore shutdown emit failures
			}
		}
	}

	/** Dispose custom surfaces on extension errors (best-effort leak prevention). */
	disposeOnExtensionError(): void {
		for (const pending of this.#pendingCustoms.values()) {
			if (pending.closed) continue;
			pending.closed = true;
			pending.reject(new Error("Extension error"));
		}
		this.#pendingCustoms.clear();
		for (const entry of Array.from(this.#components.values())) {
			if (entry.kind === "extension_custom") {
				this.#disposeComponent(entry.id, {
					settleCustom: { ok: false, error: new Error("Extension error") },
				});
			}
		}
	}

	// ---------------------------------------------------------------------------
	// Internals
	// ---------------------------------------------------------------------------

	#replaceSlot(indexKey: string, create: () => string | undefined): void {
		const previous = this.#slotIndex.get(indexKey);
		if (previous) {
			this.#disposeComponent(previous.componentId);
			this.#slotIndex.delete(indexKey);
		}
		const nextId = create();
		if (nextId) {
			const entry = this.#components.get(nextId);
			if (entry) {
				this.#slotIndex.set(indexKey, { componentId: nextId, key: entry.key });
			}
		}
	}

	#mountFactory(opts: {
		slot: RpcComponentSlot;
		kind: string;
		key?: string;
		create: (componentId: string) => Disposables;
	}): string {
		if (this.#disposed) {
			throw new Error("Remote UI host is shut down");
		}
		if (this.#components.size >= RPC_REMOTE_UI_BOUNDS.maxComponents) {
			throw new Error(`Remote component limit reached (${RPC_REMOTE_UI_BOUNDS.maxComponents})`);
		}
		const componentId = Snowflake.next() as string;
		let component: Disposables;
		try {
			component = opts.create(componentId);
		} catch (err) {
			throw err instanceof Error ? err : new Error(errorMessage(err));
		}
		const entry: RegisteredComponent = {
			id: componentId,
			slot: opts.slot,
			kind: opts.kind,
			key: opts.key,
			component,
			focused: false,
			dirty: true,
			disposed: false,
		};
		this.#components.set(componentId, entry);
		this.#emitOpen(entry);
		return componentId;
	}

	#emitOpen(entry: RegisteredComponent): void {
		const frame: RpcComponentOpenFrame = {
			v: RPC_FRONTEND_PROTOCOL_V,
			type: "component_open",
			componentId: entry.id,
			slot: entry.slot,
			kind: entry.kind,
			key: entry.key,
			wantsKeyRelease: entry.component.wantsKeyRelease === true,
		};
		this.#output(frame);
	}

	#handleRender(frame: RpcComponentRenderFrame): void {
		const componentId = frame.componentId;
		const id = frame.id;
		const generation = typeof frame.generation === "number" ? frame.generation : undefined;
		if (typeof componentId !== "string" || !componentId) {
			this.#emitResult({
				id,
				componentId: String(componentId ?? ""),
				generation,
				lines: [],
				error: "componentId required",
			});
			return;
		}
		const entry = this.#components.get(componentId);
		if (!entry || entry.disposed) {
			this.#emitResult({
				id,
				componentId,
				generation,
				lines: [],
				error: `unknown component: ${componentId}`,
			});
			return;
		}
		const width = clampInt(typeof frame.width === "number" ? frame.width : 1, 1, RPC_REMOTE_UI_BOUNDS.maxRenderWidth);
		const height =
			typeof frame.height === "number" && Number.isFinite(frame.height)
				? clampInt(frame.height, 1, RPC_REMOTE_UI_BOUNDS.maxRenderRows * 4)
				: undefined;

		// Nested overlay visible(termW, termH) stays local; emit one overlay_update
		// only on true→false / false→true transitions (never serialize the fn).
		let visibleError: string | undefined;
		if (entry.overlayId) {
			const nested = this.#nestedOverlays.get(entry.overlayId);
			if (nested && !nested.closed && !nested.hidden && nested.visible) {
				const termW =
					typeof frame.terminalWidth === "number" && Number.isFinite(frame.terminalWidth)
						? clampInt(frame.terminalWidth, 1, RPC_REMOTE_UI_BOUNDS.maxRenderWidth * 4)
						: width;
				const termH =
					typeof frame.terminalHeight === "number" && Number.isFinite(frame.terminalHeight)
						? clampInt(frame.terminalHeight, 1, RPC_REMOTE_UI_BOUNDS.maxRenderRows * 4)
						: (height ?? 24);
				let isVisible = true;
				try {
					isVisible = nested.visible(termW, termH) !== false;
				} catch (err) {
					// Fail visible; surface as bounded render error, never corrupt JSON.
					isVisible = true;
					visibleError = errorMessage(err).slice(0, 512);
				}
				if (nested.lastVisible === undefined) {
					// Seed without churn when already showing; only emit if gate starts false.
					nested.lastVisible = isVisible;
					if (!isVisible && !this.#disposed) {
						const update: RpcOverlayUpdateFrame = {
							v: RPC_FRONTEND_PROTOCOL_V,
							type: "overlay_update",
							overlayId: nested.overlayId,
							mode: "hidden",
						};
						this.#output(update);
					}
				} else if (nested.lastVisible !== isVisible) {
					nested.lastVisible = isVisible;
					if (!this.#disposed) {
						const update: RpcOverlayUpdateFrame = {
							v: RPC_FRONTEND_PROTOCOL_V,
							type: "overlay_update",
							overlayId: nested.overlayId,
							mode: isVisible ? nested.mode : "hidden",
						};
						this.#output(update);
					}
				}
			}
		}

		try {
			if (typeof entry.component.focused === "boolean") {
				entry.component.focused = entry.focused;
			}
			const raw = entry.component.render(width);
			const list = Array.isArray(raw) ? Array.from(raw as readonly string[]) : [];
			const { lines: stripped, cursorCol, cursorRow } = extractCursor(list);
			const { lines, truncated } = boundLines(stripped);
			entry.dirty = false;
			const errParts: string[] = [];
			if (visibleError) errParts.push(visibleError);
			if (truncated) errParts.push("render output truncated");
			this.#emitResult({
				id,
				componentId,
				generation,
				lines,
				cursorCol,
				cursorRow,
				error: errParts.length > 0 ? errParts.join("; ").slice(0, 512) : undefined,
			});
		} catch (err) {
			entry.dirty = true;
			const msg = errorMessage(err);
			this.#emitResult({
				id,
				componentId,
				generation,
				lines: [],
				error: (visibleError ? `${visibleError}; ${msg}` : msg).slice(0, 512),
			});
		}
	}

	#emitResult(opts: {
		id?: string;
		componentId: string;
		generation?: number;
		lines: string[];
		cursorCol?: number;
		cursorRow?: number;
		error?: string;
	}): void {
		const frame: RpcComponentResultFrame = {
			v: RPC_FRONTEND_PROTOCOL_V,
			type: "component_result",
			id: opts.id,
			componentId: opts.componentId,
			generation: opts.generation,
			lines: opts.lines,
			cursorCol: opts.cursorCol,
			cursorRow: opts.cursorRow,
			error: opts.error,
		};
		this.#output(frame);
	}

	#handleInput(frame: RpcComponentInputFrame): void {
		const componentId = frame.componentId;
		const id = frame.id;
		if (typeof componentId !== "string" || !componentId) {
			this.#emitInputResult(id, String(componentId ?? ""), false, false, "componentId required");
			return;
		}
		const entry = this.#components.get(componentId);
		if (!entry || entry.disposed) {
			this.#emitInputResult(id, componentId, false, false, `unknown component: ${componentId}`);
			return;
		}

		let handled = false;
		const dirtyBefore = entry.dirty;
		entry.dirty = false;

		try {
			const mouse = frame.mouse;
			if (mouse && typeof mouse === "object" && typeof entry.component.routeMouse === "function") {
				const row = clampInt(Number(mouse.row ?? mouse.line ?? 0), 0, RPC_REMOTE_UI_BOUNDS.maxRenderRows);
				const col = clampInt(Number(mouse.col ?? 0), 0, RPC_REMOTE_UI_BOUNDS.maxRenderWidth);
				const button = clampInt(Number(mouse.button ?? 0), 0, 255);
				const release = mouse.release === true;
				const motion = mouse.motion === true;
				const wheelRaw = mouse.wheel;
				const wheel = wheelRaw === -1 || wheelRaw === 1 ? wheelRaw : null;
				entry.component.routeMouse(
					{
						button,
						col,
						row,
						release,
						wheel,
						motion,
						leftClick: !release && wheel === null && !motion && (button & 3) === 0,
					},
					row,
					col,
				);
				handled = true;
			}

			let text: string | undefined;
			if (typeof frame.key === "string" && frame.key.length > 0) {
				text = frame.key;
			} else if (typeof frame.paste === "string") {
				const paste =
					frame.paste.length > RPC_REMOTE_UI_BOUNDS.maxInputChars
						? frame.paste.slice(0, RPC_REMOTE_UI_BOUNDS.maxInputChars)
						: frame.paste;
				text = `\x1b[200~${paste}\x1b[201~`;
			} else if (typeof frame.text === "string" && frame.text.length > 0) {
				text = frame.text;
			} else if (frame.data !== undefined) {
				text = decodeInputBytes(frame.data);
			}

			if (text !== undefined && text.length > 0) {
				if (text.length > RPC_REMOTE_UI_BOUNDS.maxInputChars) {
					text = text.slice(0, RPC_REMOTE_UI_BOUNDS.maxInputChars);
				}
				if (typeof entry.component.handleInput === "function") {
					entry.component.handleInput(text);
					handled = true;
				}
			}

			if (entry.slot === "editor" && typeof entry.component.getText === "function") {
				try {
					const t = entry.component.getText();
					if (typeof t === "string") this.setEditorTextLocal(t);
				} catch {
					// ignore
				}
			}
		} catch (err) {
			this.#emitInputResult(id, componentId, false, true, errorMessage(err));
			return;
		}

		const dirty = entry.dirty || handled || dirtyBefore;
		if (handled) entry.dirty = true;
		this.#emitInputResult(id, componentId, handled, dirty);
	}

	#emitInputResult(
		id: string | undefined,
		componentId: string,
		handled: boolean,
		dirty: boolean,
		error?: string,
	): void {
		const frame: RpcComponentInputResultFrame = {
			v: RPC_FRONTEND_PROTOCOL_V,
			type: "component_input_result",
			id,
			componentId,
			handled,
			dirty,
			error,
		};
		this.#output(frame);
	}

	#handleDispose(frame: RpcComponentDisposeFrame, hostInitiated = false): void {
		const componentId = frame.componentId;
		if (typeof componentId !== "string" || !componentId) return;
		this.#disposeComponent(componentId, {
			settleCustom: { ok: true, value: undefined },
			silent: hostInitiated,
		});
	}

	#handleFocus(frame: RpcComponentFocusFrame): void {
		const componentId = frame.componentId;
		if (typeof componentId !== "string" || !componentId) return;
		const entry = this.#components.get(componentId);
		if (!entry || entry.disposed) return;
		const focused = frame.focused === true;
		entry.focused = focused;
		if (focused) {
			// Host confirmed focus on this component — clear previous local flag.
			if (this.#focusedComponent && this.#focusedComponent !== entry.component) {
				const prevId = this.findComponentId(this.#focusedComponent);
				if (prevId && prevId !== componentId) {
					const prev = this.#components.get(prevId);
					if (prev && !prev.disposed) {
						prev.focused = false;
						try {
							if (typeof prev.component.focused === "boolean" || "focused" in prev.component) {
								prev.component.focused = false;
							}
						} catch {
							// ignore
						}
					}
				}
			}
			this.#focusedComponent = entry.component;
		} else if (this.#focusedComponent === entry.component) {
			this.#focusedComponent = null;
		}
		try {
			if (typeof entry.component.focused === "boolean" || "focused" in entry.component) {
				entry.component.focused = focused;
			}
			entry.component.setUseTerminalCursor?.(true);
		} catch {
			// ignore focus side effects
		}
		entry.dirty = true;
	}

	#handleEditorQuery(frame: RpcEditorQueryFrame): void {
		const editorSlot = this.#slotIndex.get("editor");
		if (editorSlot) {
			const entry = this.#components.get(editorSlot.componentId);
			const text = entry?.component.getText?.();
			if (typeof text === "string" && text !== this.#editorText) {
				this.setEditorTextLocal(text);
			}
		}
		const state: RpcEditorStateFrame = {
			v: RPC_FRONTEND_PROTOCOL_V,
			type: "editor_state",
			id: frame.id,
			text: this.#editorText,
			cursor: this.#editorCursor,
		};
		this.#output(state);
	}

	#handleEditorUpdate(frame: RpcEditorUpdateFrame): void {
		const op = frame.op ?? "set_text";
		if (op === "clear") {
			this.setEditorTextLocal("");
			this.#editorCursor = 0;
		} else if (op === "set_text" || op === "paste") {
			if (typeof frame.text === "string") {
				if (op === "paste") {
					const at = clampInt(this.#editorCursor, 0, this.#editorText.length);
					const next = this.#editorText.slice(0, at) + frame.text + this.#editorText.slice(at);
					this.setEditorTextLocal(next);
					this.#editorCursor = at + frame.text.length;
				} else {
					this.setEditorTextLocal(frame.text);
					if (typeof frame.cursor === "number") {
						this.#editorCursor = clampInt(frame.cursor, 0, this.#editorText.length);
					} else {
						this.#editorCursor = this.#editorText.length;
					}
				}
			}
		} else if (op === "set_cursor") {
			if (typeof frame.cursor === "number") {
				this.#editorCursor = clampInt(frame.cursor, 0, this.#editorText.length);
			}
		}

		const editorSlot = this.#slotIndex.get("editor");
		if (editorSlot) {
			const entry = this.#components.get(editorSlot.componentId);
			if (entry && typeof entry.component.setText === "function") {
				try {
					entry.component.setText(this.#editorText);
					entry.dirty = true;
				} catch {
					// ignore
				}
			}
		}

		if (frame.id) {
			const state: RpcEditorStateFrame = {
				v: RPC_FRONTEND_PROTOCOL_V,
				type: "editor_state",
				id: frame.id,
				text: this.#editorText,
				cursor: this.#editorCursor,
			};
			this.#output(state);
		}
	}

	#disposeComponent(
		componentId: string,
		opts?: {
			settleCustom?: { ok: true; value: unknown } | { ok: false; error: Error };
			silent?: boolean;
		},
	): void {
		const entry = this.#components.get(componentId);
		if (!entry || entry.disposed) return;
		entry.disposed = true;
		this.#components.delete(componentId);
		this.#pendingCustoms.delete(componentId);

		for (const [k, v] of this.#slotIndex) {
			if (v.componentId === componentId) this.#slotIndex.delete(k);
		}

		if (entry.overlayId) {
			const nested = this.#nestedOverlays.get(entry.overlayId);
			if (nested) {
				nested.closed = true;
				nested.hidden = true;
				this.#nestedOverlays.delete(entry.overlayId);
			}
		}

		if (this.#focusedComponent === entry.component) {
			this.#focusedComponent = null;
		}

		try {
			entry.component.dispose?.();
		} catch {
			// ignore dispose errors
		}

		if (entry.overlayId && !opts?.silent && !this.#disposed) {
			const unmount: RpcOverlayUnmountFrame = {
				v: RPC_FRONTEND_PROTOCOL_V,
				type: "overlay_unmount",
				overlayId: entry.overlayId,
			};
			this.#output(unmount);
		}

		if (!opts?.silent && !this.#disposed) {
			const disposeFrame: RpcComponentDisposeFrame = {
				v: RPC_FRONTEND_PROTOCOL_V,
				type: "component_dispose",
				componentId,
			};
			this.#output(disposeFrame);
		}

		const pending = entry.pendingCustom;
		if (pending && !pending.closed) {
			pending.closed = true;
			const settle = opts?.settleCustom;
			if (settle?.ok === false) pending.reject(settle.error);
			else pending.resolve(settle?.ok ? settle.value : undefined);
		}
	}

	#emitTerminalInputSubscription(active: boolean): void {
		if (this.#disposed) return;
		const frame: RpcTerminalInputSubscriptionFrame = {
			v: RPC_FRONTEND_PROTOCOL_V,
			type: "terminal_input_subscription",
			active,
		};
		this.#output(frame);
	}

	#emitTerminalInputResult(id: string, consume: boolean, data?: string, error?: string): void {
		if (this.#disposed) return;
		let outData = data;
		if (typeof outData === "string" && outData.length > RPC_REMOTE_UI_BOUNDS.maxTerminalInputChars) {
			outData = outData.slice(0, RPC_REMOTE_UI_BOUNDS.maxTerminalInputChars);
		}
		const frame: RpcTerminalInputResultFrame = {
			v: RPC_FRONTEND_PROTOCOL_V,
			type: "terminal_input_result",
			id,
			consume,
			// Only include data when not consumed (host may forward transformed text).
			data: consume ? undefined : outData,
			error,
		};
		this.#output(frame);
	}

	#rememberTerminalInputId(id: string): void {
		if (this.#terminalInputSeenIds.has(id)) return;
		this.#terminalInputSeenIds.add(id);
		this.#terminalInputSeenOrder.push(id);
		const max = RPC_REMOTE_UI_BOUNDS.maxTerminalInputSeenIds;
		while (this.#terminalInputSeenOrder.length > max) {
			const old = this.#terminalInputSeenOrder.shift();
			if (old !== undefined) this.#terminalInputSeenIds.delete(old);
		}
	}
}

/** Build a simple Text/Container widget from string lines (parity with interactive mode). */
export function linesToComponent(lines: string[], maxLines = 10): Disposables {
	const container = new Container();
	const slice = lines.slice(0, maxLines);
	for (const line of slice) {
		container.addChild(new Text(line, 1, 0));
	}
	if (lines.length > maxLines) {
		container.addChild(new Text(theme.fg("muted", "... (widget truncated)"), 1, 0));
	}
	return container;
}
