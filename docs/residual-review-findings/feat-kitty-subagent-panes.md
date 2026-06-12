# Kitty Subagent Panes Residual Review Findings

Source review: `/tmp/compound-engineering/ce-code-review/20260612-kitty-panes-autofix/`
Branch: `feat/kitty-subagent-panes`

## Residual Review Findings

- **P1** `packages/coding-agent/src/agent-control/projection.ts:226` — [Bound Kitty pane transcript invalidation backlog](https://github.com/can1357/oh-my-pi/issues/2345)
- **P1** `packages/coding-agent/src/agent-control/control.ts:133` — [Bind parked revival to admitted child identity](https://github.com/can1357/oh-my-pi/issues/2346)
- **P2** `packages/coding-agent/examples/extensions/kitty-subagent-panes.ts:272` — [Reconcile timed-out Kitty pane launches](https://github.com/can1357/oh-my-pi/issues/2347)
- **P2** `packages/coding-agent/src/agent-control/projection.ts:90` — [Stream pane follow-up turn transcript updates](https://github.com/can1357/oh-my-pi/issues/2348)
- **P2** `packages/coding-agent/src/commands/agent-pane.ts:261` — [Distinguish rejected sends from unknown outcomes](https://github.com/can1357/oh-my-pi/issues/2349)
- **P2** `packages/coding-agent/src/session/complete-entry-page.ts:45` — [Advance transcript cursor past oversized entries](https://github.com/can1357/oh-my-pi/issues/2352)
- **P2** `packages/coding-agent/examples/kitty/authorize-omp-panes.py:119` — [Scope Kitty listing to owned viewer windows](https://github.com/can1357/oh-my-pi/issues/2351)
- **P2** `packages/coding-agent/src/agent-control/server.ts:225` — [Bound sidecar body and transcript I/O](https://github.com/can1357/oh-my-pi/issues/2350)
- **P2** `packages/coding-agent/src/agent-control/server.ts:262` — [Evict settled Kitty pane command results](https://github.com/can1357/oh-my-pi/issues/2354)
- **P2** `packages/coding-agent/src/commands/agent-pane.ts:355` — [Reconnect after invalidation reconciliation failure](https://github.com/can1357/oh-my-pi/issues/2353)
- **P2** `packages/coding-agent/src/extensibility/extensions/types.ts:1106` — [Narrow public agent-control extension API](https://github.com/can1357/oh-my-pi/issues/2355)
- **P2** `packages/coding-agent/examples/extensions/kitty-subagent-panes.ts:204` — [Bound Kitty launcher queue during shutdown](https://github.com/can1357/oh-my-pi/issues/2356)
- **P3** `packages/coding-agent/src/commands/agent-pane.ts:548` — [Clear pane editor after confirmed send](https://github.com/can1357/oh-my-pi/issues/2357)
- **P3** `packages/coding-agent/src/agent-control/server.ts:165` — [Add per-pane sidecar capacity quotas](https://github.com/can1357/oh-my-pi/issues/2358)
- **P3** `packages/coding-agent/src/commands/agent-pane.ts:173` — [Validate exact pane protocol DTO unions](https://github.com/can1357/oh-my-pi/issues/2359)
