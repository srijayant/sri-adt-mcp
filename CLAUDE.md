# CLAUDE.md

This repo's agent guidance lives in [AGENTS.md](AGENTS.md) — read it first. It covers the commands, architecture, tool layout, conventions, config, and the "must not" rules. Everything there applies to Claude Code.

## Claude Code specifics

- **Verify before committing:** run `npm run build && npm test` and check `git status` so no `*.mtaext`, `.env`, or service key is staged. Commit only when asked.
- **Secrets:** the repo is public and must stay generic. Never write a real destination name, backend hostname, app route, or credential into a tracked file — those belong only in the gitignored `local.mtaext`.
- **Testing changes:** this is a deployed BTP app; you usually can't run it end-to-end locally (it needs XSUAA + a destination). Rely on `npm test` (the client and destination lister are injectable) and reason about the HTTP/auth flow rather than claiming a live check you didn't do.
- **Scope:** keep changes minimal and generic — no company-specific names, no backwards-compat shims, no new dependencies without reason.
