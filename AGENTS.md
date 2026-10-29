# AGENTS.md

Guidance for AI coding agents working in this repository. Human contributors: see [README.md](README.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## What this is

`sri-adt-mcp` is an MCP server (TypeScript, ESM, Node ≥ 20) that exposes SAP ABAP Development Tools (ADT) to AI agents. It runs on SAP BTP Cloud Foundry and reaches an ABAP system through a **BTP destination** — no backend credentials live in the app. Access requires an XSUAA **user** login (OAuth); the server never accepts technical/`client_credentials` tokens.

## Commands

```bash
npm install
npm run build      # tsc → dist/
npm test           # vitest (single suite: test/core.test.ts)
npm run dev        # run from source with tsx
npm start          # run dist/
npm run deploy     # mbt build && cf deploy (generic)
npm run deploy:local   # deploy with local.mtaext (your private extension)
```

Always run `npm run build && npm test` before committing — CI runs both on push/PR.

## Architecture

Entry: `src/index.ts` → `loadConfig()` (`src/config.ts`) → `startHttp()` (`src/httpServer.ts`). It's an HTTP MCP server (not stdio): `POST /mcp`, `GET /health`, plus OAuth endpoints.

- **`src/httpServer.ts`** — HTTP server. Validates the XSUAA JWT (`@sap/xssec`), enforces scopes (`read`/`write` → read-only vs full), holds **one stateful ADT session per user** (CSRF + cookies, 30-min idle expiry), and resolves which destination each user gets (see per-user routing below).
- **`src/oauth.ts`** — small OAuth facade in front of XSUAA (dynamic-client-registration shim MCP clients expect; adds the XSUAA client secret server-side).
- **`src/auth/identity.ts`** — `requireUser()`: rejects `client_credentials`, requires a logon name.
- **`src/http/adtClient.ts`** — the ADT HTTP client. Routes calls through the destination via `@sap-cloud-sdk/http-client`; per-destination CSRF/cookie sessions; normalises paths (`adtPath`) and passes absolute `/sap/...` paths through unchanged. A missing destination becomes a 424 naming the destination to create.
- **`src/http/destinationDirectory.ts`** — lists subaccount destinations via the destination-service binding (cached ~5 min) for property-based per-user routing.
- **`src/server.ts`** — assembles the MCP server from the tool groups.
- **`src/tools/*.ts`** — tools grouped by area: `core`, `navigate`, `source`, `checks`, `create`, `quality`, `transports`, `runtime`, `debugger`, `services`, `abapgit`. Registered via `registry.ts`.
- **`src/adt/*.ts`** — ADT helpers: `uri.ts` (object/source URI mapping + type table), `templates.ts` (create XML), `xml.ts` (parse helpers), `session.ts` (lock/unlock), `activation.ts`.

## Adding or changing a tool

Define it in the right `src/tools/<area>.ts` with a `zod` schema and a handler; mark `write: true` if it changes/runs/transports anything (those are hidden in read-only mode). Object-pointing tools take `type`+`name` (or `uri`) via `objectArgs`; resolve with `objectUri`/`sourceUri` from `src/adt/uri.ts`. Reuse `ctx.client` for backend calls — don't open your own HTTP. For ADT features without a dedicated tool, the generic `adt_request` already covers any `/sap/bc/adt` endpoint, so prefer extending behaviour over adding thin wrappers.

## Conventions

- TypeScript ESM with `.js` import specifiers (NodeNext). No implicit `any`.
- Keep backend access inside `AdtClient`; the allowlist check lives there.
- Errors surface to the agent as `err.message` (see `registry.ts`) — make them actionable.
- Add/adjust tests in `test/core.test.ts` for behaviour changes; keep them injectable (the client and destination lister take injected executors — no live network in tests).

## Config (env-driven, `src/config.ts`)

`SRI_ADT_DESTINATION` (required), `SRI_ADT_DESTINATIONS` (allowlist), `SRI_ADT_READONLY`, `SRI_ADT_ALLOWED_PACKAGES`, `SRI_ADT_TIMEOUT_MS`, `SRI_ADT_MAX_OUTPUT`, `SRI_ADT_PUBLIC_URL`. Per-developer routing: `SRI_ADT_USER_PROPERTY`, `SRI_ADT_USER_DESTINATION_PREFIX`, `SRI_ADT_DEFAULT_SYSTEM`, `SRI_ADT_USER_DESTINATIONS`, `SRI_ADT_USER_DESTINATION_TEMPLATE`, `SRI_ADT_USER_DESTINATION_REQUIRED`. See the README "Team access" section.

## Gotchas

- **Auth is user-only.** `client_credentials`/technical tokens are refused by design. A headless/unattended client cannot authenticate without a real user token.
- **ADT releases differ.** Not every tool works on every backend (e.g. `run_class` needs 7.50+; CDS/RAP need newer releases; some systems serve transports under `/sap/bc/cts`, not `/sap/bc/adt/cts`). Use `adt_discovery` to see what a backend supports; `adt_request` reaches anything.
- **Stateful sessions** are per user and per destination — lock → edit → unlock must stay on the same session.

## Must not

- Never commit `local.mtaext` / `*.mtaext`, service keys, `.env`, or any real destination name, host, or credential. `.gitignore` covers these — keep it that way. The repo must stay generic and deployable by anyone.
- Don't add backwards-compat shims or company-specific names/routes.
