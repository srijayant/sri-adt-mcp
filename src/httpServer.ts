import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as xssec from '@sap/xssec';
import type { Config } from './config.js';
import { AdtClient } from './http/adtClient.js';
import { buildServer, VERSION } from './server.js';
import { handleOAuth, resourceMetadataUrl, type OAuthDeps } from './oauth.js';
import { IdentityError, requireUser } from './auth/identity.js';

const log = (...a: unknown[]) => console.error('[sri-adt-http]', ...a);
const MAX_BODY = 20 * 1024 * 1024;
const SESSION_IDLE_MS = 30 * 60 * 1000;

interface UserSession {
  client: AdtClient;
  jwt: string;
  lastUsed: number;
}

function xsuaaCredentials(): Record<string, unknown> | undefined {
  try {
    const vcap = JSON.parse(process.env.VCAP_SERVICES ?? '{}');
    return (vcap.xsuaa?.[0] ?? Object.values(vcap).flat().find((s: any) => s?.tags?.includes('xsuaa')))?.credentials;
  } catch {
    return undefined;
  }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function startHttp(cfg: Config): Promise<void> {
  const creds = xsuaaCredentials();
  if (!creds) throw new Error('No XSUAA binding found in VCAP_SERVICES. Bind an XSUAA instance created from xs-security.json.');
  const xsuaa = new xssec.XsuaaService(creds as any);
  const oauth: OAuthDeps = {
    xsuaaUrl: String(creds.url).replace(/\/+$/, ''),
    clientId: String(creds.clientid),
    clientSecret: String(creds.clientsecret),
    publicUrl: cfg.publicUrl,
  };

  // One ADT client per user, so CSRF token, cookies and locks persist across tool calls.
  const sessions = new Map<string, UserSession>();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of sessions) if (now - v.lastUsed > SESSION_IDLE_MS) sessions.delete(k);
  }, 60_000).unref();

  const port = Number(process.env.PORT ?? 8080);

  createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0];

    if (path === '/health' || path === '/') {
      return send(res, 200, { status: 'ok', name: 'sri-adt-mcp', version: VERSION, mcp: '/mcp' });
    }
    try {
      if (await handleOAuth(req, res, path, () => readBody(req), oauth)) return;
    } catch (e) {
      log('oauth route failed:', (e as Error).message);
      if (!res.headersSent) send(res, 502, { error: 'server_error', error_description: (e as Error).message });
      return;
    }
    if (path !== '/mcp') return send(res, 404, { error: 'not found' });
    if (req.method !== 'POST') {
      return send(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server: use POST)' }, id: null }, { allow: 'POST' });
    }

    const challenge = `Bearer resource_metadata="${resourceMetadataUrl(req, oauth)}"`;
    const jwt = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1]?.trim();
    if (!jwt) return send(res, 401, { error: 'missing Bearer token' }, { 'www-authenticate': challenge });

    let user: string;
    let canWrite: boolean;
    try {
      const sc: any = await xssec.createSecurityContext(xsuaa, { jwt });
      user = requireUser(sc).user;
      if (!sc.checkLocalScope('read')) return send(res, 403, { error: 'missing scope read (assign role collection SRI_ADT_Viewer or SRI_ADT_Developer)' });
      canWrite = sc.checkLocalScope('write');
    } catch (e) {
      if (e instanceof IdentityError) return send(res, 403, { error: e.message });
      log('JWT validation failed:', (e as Error).message);
      return send(res, 401, { error: 'invalid token', detail: (e as Error).message }, { 'www-authenticate': `${challenge}, error="invalid_token"` });
    }

    const readOnly = cfg.readOnly || !canWrite;
    const key = `${user}|${readOnly ? 'ro' : 'rw'}`;
    let s = sessions.get(key);
    if (!s) {
      const created: UserSession = { jwt, lastUsed: 0, client: undefined as unknown as AdtClient };
      created.client = new AdtClient({ ...cfg, readOnly }, () => created.jwt);
      sessions.set(key, created);
      s = created;
    }
    s.jwt = jwt;
    s.lastUsed = Date.now();

    let body: unknown;
    try {
      const raw = await readBody(req);
      body = raw ? JSON.parse(raw) : undefined;
    } catch (e) {
      return send(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: `Parse error: ${(e as Error).message}` }, id: null });
    }

    const { server } = buildServer({ client: s.client, cfg: s.client.cfg });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      log('request failed:', (e as Error).message);
      if (!res.headersSent) send(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  }).listen(port, () =>
    log(`listening on :${port} (POST /mcp), destination=${cfg.destination}, allowed=${cfg.allowedDestinations.join(',')}${cfg.readOnly ? ', READ-ONLY' : ''}`),
  );
}
