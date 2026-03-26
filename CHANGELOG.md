# Changelog

All notable changes to CV-Agent will be documented in this file.

## [1.0.1] - 2026-03-26

### Fixed
- **Full output capture** — Claude Code text output is now accumulated and included in the task completion result (`output` field), so the planner receives the full response
- **Streaming progress** — Periodic progress events with output chunks are posted to CV-Hub as Claude Code streams, enabling real-time monitoring via `get_task_logs`
- **CLI lifecycle status** — Terminal now shows `📥 RECEIVED`, `🚀 RUNNING`, `✅ COMPLETED`/`❌ FAILED` status lines during task execution
- **Output buffer cap** — Full output buffer is capped at 100KB to prevent unbounded memory growth

### Added
- Output parser test suite (17 tests) covering structured markers and non-marker line handling

## [1.0.0] - 2026-03-23

### Added
- **Executor agent** — Remote Claude Code task dispatch with CV-Hub integration
- **Permission relay** — Forward prompts from executor to hub for user approval
- **Task polling** — Heartbeat-based task claim and execution loop
- **`cva` binary** — CLI entrypoint for running the agent
