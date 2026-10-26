import type { IncomingMessage, ServerResponse } from 'node:http';

// MCP-spec OAuth facade over XSUAA. XSUAA has no dynamic client registration, so /oauth/register
// hands out a fixed public client id and the real XSUAA client secret is only added server-side.

const PUBLIC_CLIENT_ID = 'sri-adt-mcp';
const DROP_PARAMS = ['resource', 'scope'];

export interface OAuthDeps {
  xsuaaUrl: string;
  clientId: string;
  clientSecret: string;
  publicUrl?: string;
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*', ...headers });
  res.end(JSON.stringify(body));
}

export function baseUrl(req: IncomingMessage, deps: OAuthDeps): string {
  if (deps.publicUrl) return deps.publicUrl.replace(/\/+$/, '');
  const proto = String(req.headers['x-forwarded-proto'] ?? 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost');
  return `${proto}://${host}`;
}

export function resourceMetadataUrl(req: IncomingMessage, deps: OAuthDeps): string {
  return `${baseUrl(req, deps)}/.well-known/oauth-protected-resource`;
}

function authServerMetadata(base: string) {
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  };
}

/** Handles OAuth/discovery routes. Returns false if the path is not an OAuth route. */
export async function handleOAuth(req: IncomingMessage, res: ServerResponse, path: string, rawBody: () => Promise<string>, deps: OAuthDeps): Promise<boolean> {
  const base = baseUrl(req, deps);

  if (req.method === 'OPTIONS' && (path.startsWith('/.well-known/') || path.startsWith('/oauth/'))) {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization, mcp-protocol-version',
    });
    res.end();
    return true;
  }

  if (path.startsWith('/.well-known/oauth-protected-resource')) {
    send(res, 200, { resource: `${base}/mcp`, authorization_servers: [base], bearer_methods_supported: ['header'] });
    return true;
  }
  if (path.startsWith('/.well-known/oauth-authorization-server') || path.startsWith('/.well-known/openid-configuration')) {
    send(res, 200, authServerMetadata(base));
    return true;
  }

  if (path === '/oauth/register' && req.method === 'POST') {
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse((await rawBody()) || '{}');
    } catch {
      /* ignore malformed metadata */
    }
    send(res, 201, {
      ...meta,
      client_id: PUBLIC_CLIENT_ID,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
    return true;
  }

  if (path === '/oauth/authorize' && req.method === 'GET') {
    const q = new URL(req.url ?? '', base).searchParams;
    q.set('client_id', deps.clientId);
    for (const p of DROP_PARAMS) q.delete(p);
    res.writeHead(302, { location: `${deps.xsuaaUrl}/oauth/authorize?${q}` });
    res.end();
    return true;
  }

  if (path === '/oauth/token' && req.method === 'POST') {
    const form = new URLSearchParams(await rawBody());
    const grant = form.get('grant_type');
    if (grant !== 'authorization_code' && grant !== 'refresh_token') {
      send(res, 400, { error: 'unsupported_grant_type' });
      return true;
    }
    form.set('client_id', deps.clientId);
    form.delete('client_secret');
    for (const p of DROP_PARAMS) form.delete(p);
    const r = await fetch(`${deps.xsuaaUrl}/oauth/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        authorization: `Basic ${Buffer.from(`${deps.clientId}:${deps.clientSecret}`).toString('base64')}`,
      },
      body: form,
    });
    const text = await r.text();
    res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
    res.end(text);
    return true;
  }

  return false;
}
