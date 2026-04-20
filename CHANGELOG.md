# Changelog

All notable changes to CV-Agent will be documented in this file.

## [1.10.0] - 2026-04-20

> Version jump: the 1.3.x–1.9.x range was published to npm from side branches
> without corresponding git commits on main. Bumping straight to 1.10.0 to
> stay ahead of the published range.

### Fixed
- **Output events now actually reach CV-Hub** — v1.2.0 posted `output` and `output_final` events but the server enum rejected them, silently swallowed by fire-and-forget error handlers. Requires cv-hub with the matching enum migration (0041).

### Added
- **Reliable event delivery** — New `EventQueue` (`src/utils/event-queue.ts`) drains output events with bounded exponential backoff, spills pending events to disk on crash or network failure, and reloads the spill on the next run for at-least-once delivery
- **Sequence numbers** — Output events carry monotonic `sequence_number` so the planner can reconstruct ordering deterministically under same-millisecond bursts
- **Truncation markers** — When the 200KB rolling output buffer drops bytes, a visible `[... N bytes truncated ...]` event is emitted instead of silently sliding
- **Event-queue test suite** — 6 tests covering delivery, retry, disk spill, replay on startup, and close semantics

### Changed
- `postTaskEvent` now accepts an optional `sequence_number` parameter
- `executeTask` creates one `EventQueue` per task and flushes it in the `finally` block

## [1.2.0] - 2026-03-30

### Added
- **Output events** — Claude Code stdout chunks are now posted as `output` task events (in addition to task logs), making them visible via `cv_task_summary` and `cv_task_stream`
- **Output final event** — On task completion, posts an `output_final` event with the last 50KB of stdout, ensuring the planner always has access to full task output
- **Self-update task type** — New `_system_update` task type allows the planner to remotely update the cv-agent binary without SSH access. Supports `npm` (install from registry) and `git:` (pull + build from source) update sources, with optional automatic restart

### Changed
- Added `MAX_OUTPUT_FINAL_BYTES` constant (50KB) for output_final event size cap

## [1.0.1] - 2026-03-26

### Fixed
- **Full output capture** — Claude Code text output is now accumulated and included in the task completion result (`output` field), so the planner receives the full response
- **Streaming progress** — Periodic progress events with output chunks are posted to CV-Hub as Claude Code streams, enabling real-time monitoring via `get_task_logs`
- **CLI lifecycle status** — Terminal now shows received, running, completed/failed status lines during task execution
- **Output buffer cap** — Full output buffer is capped at 100KB to prevent unbounded memory growth

### Added
- Output parser test suite (17 tests) covering structured markers and non-marker line handling

## [1.0.0] - 2026-03-23

### Added
- **Executor agent** — Remote Claude Code task dispatch with CV-Hub integration
- **Permission relay** — Forward prompts from executor to hub for user approval
- **Task polling** — Heartbeat-based task claim and execution loop
- **`cva` binary** — CLI entrypoint for running the agent
