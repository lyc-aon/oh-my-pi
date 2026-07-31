import { describe, expect, it } from "bun:test";
import {
	OMP_CORE_COMMAND_JSON_ENV,
	OMP_CORE_CWD_ENV,
	OMP_TUI_ACTIVE_ENV,
	OMP_TUI_BASENAME,
	OMP_TUI_BIN_ENV,
	OMP_TUI_BOOTSTRAP_JSON_ENV,
	OMP_TUI_CACHE_DIRNAME,
	OMP_TUI_PACKAGE,
	PI_TUI_FRONTEND_ENV,
	parseTuiFrontendPreference,
	RATATUI_GO_ROOT_ENV,
	RATATUI_GO_MODULE,
	RATATUI_GO_REVISION_ENV,
} from "@oh-my-pi/pi-coding-agent/modes/go-tui/constants";

describe("go-tui constants", () => {
	it("exports stable wire env and path names", () => {
		expect(OMP_TUI_ACTIVE_ENV).toBe("OMP_TUI_ACTIVE");
		expect(PI_TUI_FRONTEND_ENV).toBe("PI_TUI_FRONTEND");
		expect(OMP_TUI_BIN_ENV).toBe("OMP_TUI_BIN");
		expect(RATATUI_GO_ROOT_ENV).toBe("RATATUI_GO_ROOT");
		expect(RATATUI_GO_MODULE).toBe("github.com/lyc-aon/ratatui-go");
		expect(RATATUI_GO_REVISION_ENV).toBe("RATATUI_GO_REVISION");
		expect(OMP_CORE_COMMAND_JSON_ENV).toBe("OMP_CORE_COMMAND_JSON");
		expect(OMP_CORE_CWD_ENV).toBe("OMP_CORE_CWD");
		expect(OMP_TUI_BOOTSTRAP_JSON_ENV).toBe("OMP_TUI_BOOTSTRAP_JSON");
		expect(OMP_TUI_PACKAGE).toBe("./cmd/omp-tui");
		expect(OMP_TUI_BASENAME).toBe("omp-tui");
		expect(OMP_TUI_CACHE_DIRNAME).toBe("omp-tui");
	});
});

describe("parseTuiFrontendPreference", () => {
	it("defaults unset and empty to auto", () => {
		expect(parseTuiFrontendPreference(undefined)).toBe("auto");
		expect(parseTuiFrontendPreference("")).toBe("auto");
		expect(parseTuiFrontendPreference("   ")).toBe("auto");
	});

	it("accepts go aliases case-insensitively", () => {
		expect(parseTuiFrontendPreference("go")).toBe("go");
		expect(parseTuiFrontendPreference("GO")).toBe("go");
		expect(parseTuiFrontendPreference(" golang ")).toBe("go");
	});

	it("accepts typescript aliases case-insensitively", () => {
		expect(parseTuiFrontendPreference("typescript")).toBe("typescript");
		expect(parseTuiFrontendPreference("TS")).toBe("typescript");
		expect(parseTuiFrontendPreference("js")).toBe("typescript");
	});

	it("treats unknown values as auto (no silent go force)", () => {
		expect(parseTuiFrontendPreference("rust")).toBe("auto");
		expect(parseTuiFrontendPreference("1")).toBe("auto");
		expect(parseTuiFrontendPreference("false")).toBe("auto");
	});
});
