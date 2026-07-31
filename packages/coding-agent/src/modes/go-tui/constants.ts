/**
 * Bun launcher ↔ Go omp-tui shared constants.
 *
 * Topology: Bun launcher → Go frontend (inherits real TTY stdio) →
 * Go spawns Bun `--mode rpc-ui` core on private pipes.
 * Launcher does NOT bridge JSONL. Go owns the TTY.
 */

/** Env set by the launcher before spawning omp-tui. Prevents re-entry. */
export const OMP_TUI_ACTIVE_ENV = "OMP_TUI_ACTIVE";

/**
 * Frontend selection:
 * - unset / empty: prefer Go when an omp-tui binary is resolvable, else TS interactive
 * - "go": require Go frontend; fail clearly if missing
 * - "typescript": emergency TS interactive fallback
 */
export const PI_TUI_FRONTEND_ENV = "PI_TUI_FRONTEND";

/** Optional absolute path override for the omp-tui binary (dev/debug). */
export const OMP_TUI_BIN_ENV = "OMP_TUI_BIN";

/** Sibling Go checkout root override (build + dev resolve). Default: sibling of oh-my-pi. */
export const RATATUI_GO_ROOT_ENV = "RATATUI_GO_ROOT";

/** Canonical module path required by release builds. */
export const RATATUI_GO_MODULE = "github.com/lyc-aon/ratatui-go";

/** Optional exact Git commit required by release CI. */
export const RATATUI_GO_REVISION_ENV = "RATATUI_GO_REVISION";

/** JSON argv array for the Bun core, also accepted by omp-tui as a flag. */
export const OMP_CORE_COMMAND_JSON_ENV = "OMP_CORE_COMMAND_JSON";

/** Optional core cwd override for omp-tui. */
export const OMP_CORE_CWD_ENV = "OMP_CORE_CWD";

/**
 * JSON bootstrap payload for the initial interactive prompt / images / queue.
 * Go reads after Ready and issues rpc-ui prompt commands. Not passed on core argv.
 * Shape: { initialMessage?: string, initialImages?: ImageContent[], queuedMessages?: string[] }
 */
export const OMP_TUI_BOOTSTRAP_JSON_ENV = "OMP_TUI_BOOTSTRAP_JSON";

/** omp-tui package path inside the ratatui-go module. */
export const OMP_TUI_PACKAGE = "./cmd/omp-tui";

/** Binary basename (Windows adds .exe at resolve time). */
export const OMP_TUI_BASENAME = "omp-tui";

/** Cache subdirectory under ~/.omp: ~/.omp/omp-tui/<version>/ */
export const OMP_TUI_CACHE_DIRNAME = "omp-tui";

export type TuiFrontendPreference = "auto" | "go" | "typescript";

export function parseTuiFrontendPreference(raw: string | undefined): TuiFrontendPreference {
	if (!raw) return "auto";
	const v = raw.trim().toLowerCase();
	if (v === "go" || v === "golang") return "go";
	if (v === "typescript" || v === "ts" || v === "js") return "typescript";
	return "auto";
}
