# Security Policy

## Reporting a vulnerability

Please do **not** open a public issue for security vulnerabilities.

Instead, report privately via GitHub's [private vulnerability reporting](https://github.com/srijayant/sri-adt-mcp/security/advisories/new). Include steps to reproduce and the affected version/commit. You can expect an initial response within a few business days.

## Scope and deployment notes

This server brokers access to an ABAP system through an SAP BTP destination. When deploying:

- Access requires an XSUAA user login; only users with the configured role collection can connect.
- With a `BasicAuthentication` destination, every caller acts as the one configured ABAP user. Use `PrincipalPropagation` for per-developer identity.
- `SRI_ADT_READONLY=true` hides all write tools.
- `SRI_ADT_ALLOWED_PACKAGES` and `SRI_ADT_DESTINATIONS` restrict what callers can touch — set them to the narrowest values that work.
- Never commit destination credentials, service keys, or `*.mtaext` files containing real destination names.
