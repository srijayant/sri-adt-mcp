# Contributing

Thanks for your interest in improving sri-adt-mcp.

## Development

```bash
npm install
npm run build     # tsc
npm test          # vitest
npm run dev       # run locally with tsx
```

Node 20+ is required.

## Pull requests

- Keep changes focused; one logical change per PR.
- Run `npm run build` and `npm test` before opening a PR — CI runs both.
- Match the existing code style (TypeScript ESM, no implicit `any`).
- Add or update tests in `test/` for behavior changes.

## Reporting issues

Use GitHub Issues. For anything security-sensitive, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
