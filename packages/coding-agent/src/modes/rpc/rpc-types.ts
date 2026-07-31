/**
 * RPC protocol types for headless operation.
 *
 * Commands are sent as JSON lines on stdin.
 * Responses and events are emitted as JSON lines on stdout.
 */
import type { AgentMessage, AgentToolResult, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import type { Effort, ImageContent, Model, ToolExample } from "@oh-my-pi/pi-ai";
import type { BashResult } from "../../exec/bash-executor";
import type { ContextUsage } from "../../extensibility/extensions/types";
import type { AgentSessionEvent, SessionStats } from "../../session/agent-session";
import type { FileEntry } from "../../session/session-entries";
import type { AvailableSlashCommandSource } from "../../slash-commands/available-commands";
import type {
	AgentProgress,
	SubagentEventPayload,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
} from "../../task";
import type { TodoPhase } from "../../tools/todo";

// ============================================================================
// RPC Commands (stdin)
// ============================================================================

export type RpcCommand =
	// Prompting
	| { id?: string; type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
	| { id?: string; type: "steer"; message: string; images?: ImageContent[] }
	| { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
	| { id?: string; type: "abort" }
	| { id?: string; type: "abort_and_prompt"; message: string; images?: ImageContent[] }
	| { id?: string; type: "new_session"; parentSession?: string }

	// State
	| { id?: string; type: "get_state" }
	| { id?: string; type: "get_available_commands" }
	| { id?: string; type: "set_todos"; phases: TodoPhase[] }
	| { id?: string; type: "set_host_tools"; tools: RpcHostToolDefinition[] }
	| { id?: string; type: "set_host_uri_schemes"; schemes: RpcHostUriSchemeDefinition[] }
	| { id?: string; type: "set_subagent_subscription"; level: RpcSubagentSubscriptionLevel }
	| { id?: string; type: "get_subagents" }
	| { id?: string; type: "get_subagent_messages"; subagentId?: string; sessionFile?: string; fromByte?: number }

	// Model
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	| { id?: string; type: "cycle_model" }
	| { id?: string; type: "get_available_models" }

	// Thinking
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
	| { id?: string; type: "cycle_thinking_level" }

	// Queue modes
	| { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_interrupt_mode"; mode: "immediate" | "wait" }

	// Compaction
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "set_auto_compaction"; enabled: boolean }

	// Retry
	| { id?: string; type: "set_auto_retry"; enabled: boolean }
	| { id?: string; type: "abort_retry" }

	// Bash
	| { id?: string; type: "bash"; command: string }
	| { id?: string; type: "abort_bash" }

	// Session
	| { id?: string; type: "get_session_stats" }
	| { id?: string; type: "export_html"; outputPath?: string }
	| { id?: string; type: "switch_session"; sessionPath: string }
	| { id?: string; type: "branch"; entryId: string }
	| { id?: string; type: "get_branch_messages" }
	| { id?: string; type: "get_last_assistant_text" }
	| { id?: string; type: "set_session_name"; name: string }
	| { id?: string; type: "handoff"; customInstructions?: string }

	// Messages
	| { id?: string; type: "get_messages" }

	// Login
	| { id?: string; type: "get_login_providers" }
	| { id?: string; type: "login"; providerId: string };

// ============================================================================
// RPC State
// ============================================================================

export interface RpcSessionState {
	model?: Model;
	thinkingLevel: ThinkingLevel | undefined;
	isStreaming: boolean;
	isCompacting: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	interruptMode: "immediate" | "wait";
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	autoCompactionEnabled: boolean;
	messageCount: number;
	queuedMessageCount: number;
	todoPhases: TodoPhase[];
	/** For session dump / export (plain-text parity with /dump). */
	systemPrompt?: string[];
	dumpTools?: Array<{ name: string; description: string; parameters: unknown; examples?: readonly ToolExample[] }>;
	/** Current context window usage. */
	contextUsage?: ContextUsage;
}

export interface RpcAvailableSlashCommand {
	name: string;
	aliases?: string[];
	description?: string;
	input?: { hint?: string };
	subcommands?: Array<{ name: string; description?: string; usage?: string }>;
	source: AvailableSlashCommandSource;
}

export interface RpcAvailableCommandsUpdateFrame {
	type: "available_commands_update";
	commands: RpcAvailableSlashCommand[];
}

export interface RpcPromptResultFrame {
	type: "prompt_result";
	id?: string;
	agentInvoked: boolean;
}

export interface RpcHandoffResult {
	savedPath?: string;
}

export type RpcSubagentSubscriptionLevel = "off" | "progress" | "events";

export interface RpcSubagentSnapshot {
	id: string;
	index: number;
	agent: string;
	agentSource: AgentProgress["agentSource"];
	description?: string;
	status: AgentProgress["status"];
	task?: string;
	assignment?: string;
	sessionFile?: string;
	lastUpdate: number;
	progress?: AgentProgress;
	parentToolCallId?: string;
}

export interface RpcSubagentMessagesResult {
	sessionFile: string;
	fromByte: number;
	nextByte: number;
	reset: boolean;
	entries: FileEntry[];
	messages: AgentMessage[];
}

// ============================================================================
// RPC Responses (stdout)
// ============================================================================

// Success responses with data
export type RpcResponse =
	// Prompting (async - events follow)
	| { id?: string; type: "response"; command: "prompt"; success: true; data?: { agentInvoked: boolean } }
	| { id?: string; type: "response"; command: "steer"; success: true }
	| { id?: string; type: "response"; command: "follow_up"; success: true }
	| { id?: string; type: "response"; command: "abort"; success: true }
	| { id?: string; type: "response"; command: "abort_and_prompt"; success: true }
	| { id?: string; type: "response"; command: "new_session"; success: true; data: { cancelled: boolean } }

	// State
	| { id?: string; type: "response"; command: "get_state"; success: true; data: RpcSessionState }
	| {
			id?: string;
			type: "response";
			command: "get_available_commands";
			success: true;
			data: { commands: RpcAvailableSlashCommand[] };
	  }
	| { id?: string; type: "response"; command: "set_todos"; success: true; data: { todoPhases: TodoPhase[] } }
	| { id?: string; type: "response"; command: "set_host_tools"; success: true; data: { toolNames: string[] } }
	| { id?: string; type: "response"; command: "set_host_uri_schemes"; success: true; data: { schemes: string[] } }
	| {
			id?: string;
			type: "response";
			command: "set_subagent_subscription";
			success: true;
			data: { level: RpcSubagentSubscriptionLevel };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_subagents";
			success: true;
			data: { subagents: RpcSubagentSnapshot[] };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_subagent_messages";
			success: true;
			data: RpcSubagentMessagesResult;
	  }

	// Model
	| {
			id?: string;
			type: "response";
			command: "set_model";
			success: true;
			data: Model;
	  }
	| {
			id?: string;
			type: "response";
			command: "cycle_model";
			success: true;
			data: { model: Model; thinkingLevel: ThinkingLevel | undefined; isScoped: boolean } | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_models";
			success: true;
			data: { models: Model[] };
	  }

	// Thinking
	| { id?: string; type: "response"; command: "set_thinking_level"; success: true }
	| {
			id?: string;
			type: "response";
			command: "cycle_thinking_level";
			success: true;
			data: { level: Effort } | null;
	  }

	// Queue modes
	| { id?: string; type: "response"; command: "set_steering_mode"; success: true }
	| { id?: string; type: "response"; command: "set_follow_up_mode"; success: true }
	| { id?: string; type: "response"; command: "set_interrupt_mode"; success: true }

	// Compaction
	| { id?: string; type: "response"; command: "compact"; success: true; data: CompactionResult }
	| { id?: string; type: "response"; command: "set_auto_compaction"; success: true }

	// Retry
	| { id?: string; type: "response"; command: "set_auto_retry"; success: true }
	| { id?: string; type: "response"; command: "abort_retry"; success: true }

	// Bash
	| { id?: string; type: "response"; command: "bash"; success: true; data: BashResult }
	| { id?: string; type: "response"; command: "abort_bash"; success: true }

	// Session
	| { id?: string; type: "response"; command: "get_session_stats"; success: true; data: SessionStats }
	| { id?: string; type: "response"; command: "export_html"; success: true; data: { path: string } }
	| { id?: string; type: "response"; command: "switch_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "branch"; success: true; data: { text: string; cancelled: boolean } }
	| {
			id?: string;
			type: "response";
			command: "get_branch_messages";
			success: true;
			data: { messages: Array<{ entryId: string; text: string }> };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_last_assistant_text";
			success: true;
			data: { text: string | null };
	  }
	| { id?: string; type: "response"; command: "set_session_name"; success: true }
	| { id?: string; type: "response"; command: "handoff"; success: true; data: RpcHandoffResult | null }

	// Messages
	| { id?: string; type: "response"; command: "get_messages"; success: true; data: { messages: AgentMessage[] } }

	// Login
	| {
			id?: string;
			type: "response";
			command: "get_login_providers";
			success: true;
			data: { providers: Array<{ id: string; name: string; available: boolean; authenticated: boolean }> };
	  }
	| { id?: string; type: "response"; command: "login"; success: true; data: { providerId: string } }

	// Error response (any command can fail)
	| { id?: string; type: "response"; command: string; success: false; error: string };

// ============================================================================
// Subagent Events (stdout)
// ============================================================================

export interface RpcSubagentLifecycleFrame {
	type: "subagent_lifecycle";
	payload: SubagentLifecyclePayload;
}

export interface RpcSubagentProgressFrame {
	type: "subagent_progress";
	payload: SubagentProgressPayload;
}

export interface RpcSubagentEventFrame {
	type: "subagent_event";
	payload: SubagentEventPayload;
}

export type RpcSubagentFrame = RpcSubagentLifecycleFrame | RpcSubagentProgressFrame | RpcSubagentEventFrame;

export type RpcSessionEventFrame = AgentSessionEvent | RpcSubagentFrame;

// ============================================================================
// Extension UI Events (stdout)
// ============================================================================

/** Emitted when an extension needs user input */
export type RpcExtensionUIRequest =
	| { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| {
			type: "extension_ui_request";
			id: string;
			method: "input";
			title: string;
			placeholder?: string;
			timeout?: number;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "editor";
			title: string;
			prefill?: string;
			promptStyle?: boolean;
	  }
	| { type: "extension_ui_request"; id: string; method: "cancel"; targetId: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "notify";
			message: string;
			notifyType?: "info" | "warning" | "error";
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setStatus";
			statusKey: string;
			statusText: string | undefined;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines: string[] | undefined;
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string }
	| { type: "extension_ui_request"; id: string; method: "open_url"; url: string; instructions?: string };

// ============================================================================
// Host Tool Frames (bidirectional)
// ============================================================================

export interface RpcHostToolDefinition {
	name: string;
	label?: string;
	description: string;
	parameters: Record<string, unknown>;
	hidden?: boolean;
}

/** Emitted by the RPC server when it needs the host to execute a registered tool. */
export interface RpcHostToolCallRequest {
	type: "host_tool_call";
	id: string;
	toolCallId: string;
	toolName: string;
	arguments: Record<string, unknown>;
}

/** Emitted by the RPC server when a pending host tool call should be aborted. */
export interface RpcHostToolCancelRequest {
	type: "host_tool_cancel";
	id: string;
	targetId: string;
}

/** Sent by the host to stream partial tool updates back to the RPC server. */
export interface RpcHostToolUpdate {
	type: "host_tool_update";
	id: string;
	partialResult: AgentToolResult<unknown>;
}

/** Sent by the host to complete a pending tool call. */
export interface RpcHostToolResult {
	type: "host_tool_result";
	id: string;
	result: AgentToolResult<unknown>;
	isError?: boolean;
}

// ============================================================================
// Host URI Frames (bidirectional)
// ============================================================================

export interface RpcHostUriSchemeDefinition {
	/** URL scheme without trailing `://` (e.g. `db`, `notion`). */
	scheme: string;
	/** Optional human-readable description for logs/diagnostics. */
	description?: string;
	/** When true, the write tool is allowed to dispatch writes to this scheme. */
	writable?: boolean;
	/** When true, downstream callers suppress hashline anchors for resolved content. */
	immutable?: boolean;
}

export type RpcHostUriOperation = "read" | "write";

/** Emitted by the RPC server when it needs the host to satisfy a URI operation. */
export interface RpcHostUriRequest {
	type: "host_uri_request";
	id: string;
	operation: RpcHostUriOperation;
	url: string;
	/** Present for write operations. */
	content?: string;
}

/** Emitted by the RPC server when a pending URI request should be aborted. */
export interface RpcHostUriCancelRequest {
	type: "host_uri_cancel";
	id: string;
	targetId: string;
}

/** Sent by the host to complete a pending URI request. */
export interface RpcHostUriResult {
	type: "host_uri_result";
	id: string;
	/**
	 * Required for successful `read` results. Ignored for `write` success.
	 * Set on errors when a textual explanation accompanies `isError`.
	 */
	content?: string;
	/** Defaults to `text/plain` when omitted. */
	contentType?: "text/markdown" | "application/json" | "text/plain";
	/** Optional resolution notes propagated to the read tool. */
	notes?: string[];
	/** Overrides the scheme-level `immutable` flag for this single resolution. */
	immutable?: boolean;
	/** When true, surface the result content as an error to the caller. */
	isError?: boolean;
	/** Optional error message; preferred over `content` for error surfacing. */
	error?: string;
}

// ============================================================================
// Extension UI Commands (stdin)
// ============================================================================

/** Response to an extension UI request */
export type RpcExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true; timedOut?: boolean };

// ============================================================================
// Remote component + editor/working frames (additive; Go ompui/protocol)
// Bare JSONL — no hello required. Historical clients ignore unknown types.
// ============================================================================

/** Protocol major mirrored from Go ompui/protocol.Major. */
export const RPC_FRONTEND_PROTOCOL_V = 1 as const;

export type RpcComponentSlot =
	| "overlay"
	| "footer"
	| "header"
	| "editor"
	| "widget_above"
	| "widget_below"
	| "tool_call"
	| "tool_result"
	| "custom";

/** Bun→Go: open a remote component session (ComponentOpenPayload). */
export interface RpcComponentOpenFrame {
	v?: typeof RPC_FRONTEND_PROTOCOL_V;
	type: "component_open";
	id?: string;
	componentId: string;
	slot?: RpcComponentSlot;
	kind?: string;
	key?: string;
	props?: unknown;
	wantsKeyRelease?: boolean;
}

/** Go→Bun: request render at width (ComponentRenderPayload). */
export interface RpcComponentRenderFrame {
	v?: typeof RPC_FRONTEND_PROTOCOL_V;
	type: "component_render";
	id?: string;
	componentId: string;
	width: number;
	height?: number;
	/** Full terminal geometry for OverlayOptions.visible(termWidth, termHeight). */
	terminalWidth?: number;
	terminalHeight?: number;
	generation?: number;
}

/** Bun→Go: ANSI row render result (ComponentResultPayload). */
export interface RpcComponentResultFrame {
	v?: typeof RPC_FRONTEND_PROTOCOL_V;
	type: "component_result";
	id?: string;
	componentId: string;
	generation?: number;
	lines: string[];
	cursorCol?: number;
	cursorRow?: number;
	liveRegionStart?: number;
	commitSafeEnd?: number;
	snapshotSafeEnd?: number;
	error?: string;
}

/** Structured mouse payload accepted on component_input (assignment extension). */
export interface RpcComponentMouseInput {
	button?: number;
	col?: number;
	row?: number;
	/** Alias for row. */
	line?: number;
	release?: boolean;
	wheel?: -1 | 1 | null;
	motion?: boolean;
}

/**
 * Go→Bun: forward key/paste/mouse/raw input (ComponentInputPayload + extras).
 * `data`/`text` match Go; `key`/`paste`/`mouse` are additive convenience fields.
 */
export interface RpcComponentInputFrame {
	v?: typeof RPC_FRONTEND_PROTOCOL_V;
	type: "component_input";
	id?: string;
	componentId: string;
	/** Raw bytes (base64 string or number[] when present). */
	data?: string | number[];
	/** UTF-8 convenience form from Go. */
	text?: string;
	/** Convenience: single key / CSI sequence. */
	key?: string;
	/** Convenience: paste body (wrapped in bracketed-paste by Bun). */
	paste?: string;
	/** Convenience: structured mouse event. */
	mouse?: RpcComponentMouseInput;
}

/** Bun→Go: input handling outcome (handled/dirty flags). */
export interface RpcComponentInputResultFrame {
	v?: typeof RPC_FRONTEND_PROTOCOL_V;
	type: "component_input_result";
	id?: string;
	componentId: string;
	handled: boolean;
	dirty: boolean;
	error?: string;
}

/** Either direction: pixels stale (ComponentInvalidatePayload). */
export interface RpcComponentInvalidateFrame {
	v?: typeof RPC_FRONTEND_PROTOCOL_V;
	type: "component_invalidate";
	id?: string;
	componentId: string;
}

/** Either direction: tear down session (ComponentDisposePayload). */
export interface RpcComponentDisposeFrame {
	v?: typeof RPC_FRONTEND_PROTOCOL_V;
	type: "component_dispose";
	id?: string;
	componentId: string;
}

/** Go→Bun: focus gain/loss (ComponentFocusPayload). */
export interface RpcComponentFocusFrame {
	v?: typeof RPC_FRONTEND_PROTOCOL_V;
	type: "component_focus";
	id?: string;
	componentId: string;
	focused: boolean;
}

/** Bun→Go: set/clear working message (WorkingMessagePayload). */
export interface RpcWorkingMessageFrame {
	v?: typeof RPC_FRONTEND_PROTOCOL_V;
	type: "working_message";
	id?: string;
	message?: string;
	clear?: boolean;
}

/** Bun→Go or Go→Bun: editor buffer snapshot (EditorStatePayload). */
export interface RpcEditorStateFrame {
	v?: typeof RPC_FRONTEND_PROTOCOL_V;
	type: "editor_state";
	id?: string;
	text: string;
	/** Absolute UTF-16 code-unit offset, matching JavaScript string indexing. */
	cursor?: number;
	/** Selection endpoint in the same UTF-16 code-unit coordinate space. */
	selectionEnd?: number;
	placeholder?: string;
}

/** Go→Bun: request editor snapshot (EditorQueryPayload). */
export interface RpcEditorQueryFrame {
	v?: typeof RPC_FRONTEND_PROTOCOL_V;
	type: "editor_query";
	id?: string;
}

/** Go→Bun: mutate editor buffer (EditorUpdatePayload). */
export interface RpcEditorUpdateFrame {
	v?: typeof RPC_FRONTEND_PROTOCOL_V;
	type: "editor_update";
	id?: string;
	op?: "set_text" | "paste" | "clear" | "set_cursor";
	text?: string;
	/** Absolute UTF-16 code-unit offset, matching JavaScript string indexing. */
	cursor?: number;
	/** Selection endpoint in the same UTF-16 code-unit coordinate space. */
	selectionEnd?: number;
}

/** Absolute cells or percent string (e.g. "50%"), matching TUI SizeValue. */
export type RpcOverlaySizeValue = number | string;

/** Allowed overlay anchors (matches pi-tui OverlayAnchor). */
export type RpcOverlayAnchor =
	| "center"
	| "top-left"
	| "top-right"
	| "bottom-left"
	| "bottom-right"
	| "top-center"
	| "bottom-center"
	| "left-center"
	| "right-center";

/** Uniform number or per-side inset object. */
export type RpcOverlayMargin =
	| number
	| {
			top?: number;
			right?: number;
			bottom?: number;
			left?: number;
	  };

/** Bun→Go: mount overlay chrome (OverlayMountPayload + OverlayOptions fields). */
export interface RpcOverlayMountFrame {
	v?: typeof RPC_FRONTEND_PROTOCOL_V;
	type: "overlay_mount";
	id?: string;
	overlayId: string;
	componentId?: string;
	mode?: "modal" | "alt_screen" | "inline";
	title?: string;
	zIndex?: number;
	/** Width in cells or percent string. */
	width?: RpcOverlaySizeValue;
	/** Minimum width in cells. */
	minWidth?: number;
	/** Max height in rows or percent string. */
	maxHeight?: RpcOverlaySizeValue;
	/** Anchor point (default center on host when omitted/invalid). */
	anchor?: RpcOverlayAnchor;
	/** Horizontal offset from anchor (positive = right). */
	offsetX?: number;
	/** Vertical offset from anchor (positive = down). */
	offsetY?: number;
	/** Explicit row: absolute or percent from top. */
	row?: RpcOverlaySizeValue;
	/** Explicit col: absolute or percent from left. */
	col?: RpcOverlaySizeValue;
	/** Uniform margin number or {top,right,bottom,left}. */
	margin?: RpcOverlayMargin;
	/** Borrow alt screen while topmost (also mode=alt_screen). */
	fullscreen?: boolean;
}

/** Bun→Go: patch overlay chrome / visibility without remounting. */
export interface RpcOverlayUpdateFrame {
	v?: typeof RPC_FRONTEND_PROTOCOL_V;
	type: "overlay_update";
	id?: string;
	overlayId: string;
	/** mode=hidden → SetHidden(true); modal/alt_screen/inline → unhide. */
	mode?: "modal" | "alt_screen" | "inline" | "hidden";
	title?: string;
	zIndex?: number;
}

/** Either direction: unmount overlay (OverlayUnmountPayload). */
export interface RpcOverlayUnmountFrame {
	v?: typeof RPC_FRONTEND_PROTOCOL_V;
	type: "overlay_unmount";
	id?: string;
	overlayId: string;
}

/** Bun→Go: focus request for a component this side owns (not host-forced). */
export interface RpcComponentFocusRequestFrame {
	v?: typeof RPC_FRONTEND_PROTOCOL_V;
	type: "component_focus_request";
	id?: string;
	componentId: string;
	/** Desired focus state; defaults to true when omitted. */
	focused?: boolean;
}

/**
 * Bun→Go: whether any extension terminal-input listeners are registered.
 * Emitted only on 0↔1 transitions so the host can stop/start key forwarding.
 */
export interface RpcTerminalInputSubscriptionFrame {
	v?: typeof RPC_FRONTEND_PROTOCOL_V;
	type: "terminal_input_subscription";
	id?: string;
	/** True when at least one listener is active. */
	active: boolean;
}

/**
 * Go→Bun: forward a raw terminal input chunk to registered onTerminalInput listeners.
 * Host should only send while subscription.active is true.
 */
export interface RpcTerminalInputFrame {
	v?: typeof RPC_FRONTEND_PROTOCOL_V;
	type: "terminal_input";
	/** Correlation id echoed on terminal_input_result. */
	id: string;
	/** Raw bytes (base64 string or number[] when present). */
	data?: string | number[];
	/** UTF-8 convenience form from Go. */
	text?: string;
}

/**
 * Bun→Go: outcome of running terminal-input listeners in registration order.
 * `consume:true` means input must not reach the normal focused component path.
 * `data` is the (possibly transformed) payload when not fully consumed.
 */
export interface RpcTerminalInputResultFrame {
	v?: typeof RPC_FRONTEND_PROTOCOL_V;
	type: "terminal_input_result";
	id: string;
	consume: boolean;
	data?: string;
	error?: string;
}

/** Bun→Go (or reply to theme_query): active theme name + optional appearance/palette. */
export type RpcThemeAppearance = "dark" | "light";

/** Semantic hex fields matching Go view.Palette (strict #RRGGBB on apply). */
export interface RpcThemeSyncPalette {
	text?: string;
	muted?: string;
	dim?: string;
	accent?: string;
	success?: string;
	error?: string;
	warning?: string;
	thinking?: string;
	code?: string;
	border?: string;
	user?: string;
}

export interface RpcThemeSyncFrame {
	v?: typeof RPC_FRONTEND_PROTOCOL_V;
	type: "theme_sync";
	id?: string;
	name: string;
	appearance?: RpcThemeAppearance;
	palette?: RpcThemeSyncPalette;
}

/** Go→Bun: ask for current theme name (reply with theme_sync). */
export interface RpcThemeQueryFrame {
	v?: typeof RPC_FRONTEND_PROTOCOL_V;
	type: "theme_query";
	id?: string;
}

/**
 * Either direction: tool-card expansion state.
 * Host may push `expanded` or set `query:true` to read the Bun cache.
 */
export interface RpcToolsExpandedFrame {
	v?: typeof RPC_FRONTEND_PROTOCOL_V;
	type: "tools_expanded";
	id?: string;
	expanded?: boolean;
	/** When true, Bun replies with tools_expanded carrying the cached expanded flag. */
	query?: boolean;
}

/** Host→Bun remote UI request union (stdin). */
export type RpcRemoteUiInboundFrame =
	| RpcComponentRenderFrame
	| RpcComponentInputFrame
	| RpcComponentDisposeFrame
	| RpcComponentFocusFrame
	| RpcComponentOpenFrame
	| RpcComponentInvalidateFrame
	| RpcEditorQueryFrame
	| RpcEditorUpdateFrame
	| RpcEditorStateFrame
	| RpcWorkingMessageFrame
	| RpcOverlayUnmountFrame
	| RpcTerminalInputFrame
	| RpcThemeQueryFrame
	| RpcToolsExpandedFrame;

/** Bun→host remote UI emit union (stdout). */
export type RpcRemoteUiOutboundFrame =
	| RpcComponentOpenFrame
	| RpcComponentResultFrame
	| RpcComponentInvalidateFrame
	| RpcComponentInputResultFrame
	| RpcComponentDisposeFrame
	| RpcWorkingMessageFrame
	| RpcEditorStateFrame
	| RpcOverlayMountFrame
	| RpcOverlayUpdateFrame
	| RpcOverlayUnmountFrame
	| RpcComponentFocusRequestFrame
	| RpcTerminalInputSubscriptionFrame
	| RpcTerminalInputResultFrame
	| RpcThemeSyncFrame
	| RpcToolsExpandedFrame;

// ============================================================================
// Helper type for extracting command types
// ============================================================================

export type RpcCommandType = RpcCommand["type"];
