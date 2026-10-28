import { executeHttpRequest } from '@sap-cloud-sdk/http-client';
import type { Config } from '../config.js';

export type QueryValue = string | number | boolean | undefined | null | Array<string | number | boolean>;

export interface AdtRequest {
  method?: string;
  /** Path under /sap/bc/adt, e.g. "/oo/classes/zcl_foo". A leading "/sap/bc/adt" is stripped. */
  path: string;
  query?: Record<string, QueryValue>;
  headers?: Record<string, string>;
  body?: string;
  accept?: string;
  contentType?: string;
  destination?: string;
  stateful?: boolean;
  /** Return non-2xx responses instead of throwing. */
  allowError?: boolean;
}

export interface AdtResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export class AdtError extends Error {
  constructor(
    public status: number,
    message: string,
    public body: string,
  ) {
    super(message);
  }
}

/** Minimal shape of the Cloud SDK call, injectable for tests. */
export type Executor = (
  dest: { destinationName: string; jwt: string },
  req: {
    method: string;
    url: string;
    headers: Record<string, string>;
    data?: string;
    timeout: number;
    responseType: 'arraybuffer';
    validateStatus: () => boolean;
  },
  opts: { fetchCsrfToken: false },
) => Promise<{ status: number; headers: Record<string, unknown>; data: unknown }>;

export interface AdtClientOptions {
  execute?: Executor;
}

const log = (...a: unknown[]) => console.error('[sri-adt]', ...a);

/**
 * Normalise an ADT URI or path. ADT-relative paths ("/oo/classes/x") and the "/sap/bc/adt" URI
 * are returned relative to /sap/bc/adt. An absolute ICF path outside the ADT base (e.g.
 * "/sap/bc/cts/transportrequests", advertised by discovery on older releases) is passed through
 * unchanged so it can be addressed directly.
 */
export function adtPath(p: string): string {
  let s = p.trim();
  s = s.replace(/^https?:\/\/[^/]+/i, '');
  if (/^\/sap\//i.test(s) && !/^\/sap\/bc\/adt(?=\/|$)/i.test(s)) return s;
  s = s.replace(/^\/sap\/bc\/adt(?=\/|$)/i, '');
  if (!s.startsWith('/')) s = '/' + s;
  return s;
}

function buildQuery(q?: Record<string, QueryValue>): string {
  if (!q) return '';
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) v.forEach((x) => sp.append(k, String(x)));
    else sp.append(k, String(v));
  }
  return sp.toString();
}

/** Extracts the human message from an ADT <exc:exception> body. */
export function adtErrorMessage(body: string): string | undefined {
  const m =
    body.match(/<(?:\w+:)?localizedMessage[^>]*>([\s\S]*?)<\/(?:\w+:)?localizedMessage>/) ??
    body.match(/<(?:\w+:)?message[^>]*>([\s\S]*?)<\/(?:\w+:)?message>/);
  return m?.[1]?.trim();
}

interface Session {
  cookies: Map<string, string>;
  csrf?: string;
}

interface RawResponse {
  status: number;
  headers: Record<string, string>;
  setCookie: string[];
  body: string;
}

/**
 * ADT client for one signed-in user. Calls go through the BTP destination, which authenticates to ABAP
 * (the configured user, or the caller via principal propagation, since the user JWT is passed along).
 */
export class AdtClient {
  private sessions = new Map<string, Session>();
  private execute: Executor;

  constructor(
    public readonly cfg: Config,
    private userJwt: () => string | undefined,
    opts: AdtClientOptions = {},
  ) {
    this.execute = opts.execute ?? (executeHttpRequest as unknown as Executor);
  }

  private destinationFor(req: { destination?: string }): string {
    const dest = req.destination ?? this.cfg.destination;
    if (!this.cfg.allowedDestinations.includes(dest)) {
      throw new AdtError(400, `Destination "${dest}" is not allowed (SRI_ADT_DESTINATIONS: ${this.cfg.allowedDestinations.join(', ')})`, 'destination not allowed');
    }
    return dest;
  }

  private session(dest: string): Session {
    let s = this.sessions.get(dest);
    if (!s) {
      s = { cookies: new Map() };
      this.sessions.set(dest, s);
    }
    return s;
  }

  /** Drop CSRF token and cookies (ends the stateful backend session from our side). */
  resetSession(dest?: string): void {
    this.sessions.delete(dest ?? this.cfg.destination);
  }

  private async raw(req: AdtRequest, dest: string, jwt: string, s: Session, extra: Record<string, string>): Promise<RawResponse> {
    const method = (req.method ?? 'GET').toUpperCase();
    const qs = buildQuery(req.query);
    const path = adtPath(req.path);
    const rel = path.startsWith('/sap/') ? path : `/sap/bc/adt${path}`;
    const url = `${rel}${qs ? (rel.includes('?') ? '&' : '?') + qs : ''}`;

    const headers: Record<string, string> = { ...extra };
    if (req.accept) headers.accept = req.accept;
    if (req.contentType) headers['content-type'] = req.contentType;
    if (req.stateful) headers['x-sap-adt-sessiontype'] = 'stateful';
    if (s.cookies.size) headers.cookie = [...s.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    Object.assign(headers, lowerKeys(req.headers ?? {}));

    let r: { status: number; headers: Record<string, unknown>; data: unknown };
    try {
      r = await this.execute(
        { destinationName: dest, jwt },
        {
          method,
          url,
          headers,
          data: req.body !== undefined && method !== 'GET' && method !== 'HEAD' ? req.body : undefined,
          timeout: this.cfg.timeoutMs,
          responseType: 'arraybuffer',
          validateStatus: () => true,
        },
        { fetchCsrfToken: false },
      );
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      if (/destination/i.test(msg) && /(not be found|not found|unable to find|could not.{0,40}find|does not exist|no destination|was not found)/i.test(msg)) {
        throw new AdtError(
          424,
          `BTP destination "${dest}" could not be found. Create an HTTP destination named exactly "${dest}" in this app's subaccount, pointing at the ABAP system (Authentication = BasicAuthentication with an ABAP user, or PrincipalPropagation). Then retry.`,
          msg,
        );
      }
      throw new AdtError(502, `Could not reach BTP destination "${dest}": ${msg}`, msg);
    }

    const flat: Record<string, string> = {};
    let setCookie: string[] = [];
    for (const [k, v] of Object.entries(r.headers ?? {})) {
      const key = k.toLowerCase();
      if (key === 'set-cookie') setCookie = Array.isArray(v) ? v.map(String) : [String(v)];
      else if (v !== undefined && v !== null) flat[key] = Array.isArray(v) ? v.join(', ') : String(v);
    }
    for (const c of setCookie) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      if (i > 0) s.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
    return { status: r.status, headers: flat, setCookie, body: decode(r.data) };
  }

  private async fetchCsrf(req: AdtRequest, dest: string, jwt: string, s: Session): Promise<void> {
    const res = await this.raw({ path: '/discovery', stateful: req.stateful, accept: 'application/atomsvc+xml' }, dest, jwt, s, { 'x-csrf-token': 'fetch' });
    const t = res.headers['x-csrf-token'];
    if (!t || t.toLowerCase() === 'required') {
      throw new AdtError(res.status, `Could not obtain CSRF token (HTTP ${res.status}): ${adtErrorMessage(res.body) ?? res.body.slice(0, 300)}`, res.body);
    }
    s.csrf = t;
  }

  async request(req: AdtRequest): Promise<AdtResponse> {
    const method = (req.method ?? 'GET').toUpperCase();
    const needsCsrf = !['GET', 'HEAD', 'OPTIONS'].includes(method);
    const jwt = this.userJwt();
    if (!jwt) throw new AdtError(401, 'No signed-in user token available', '');
    const dest = this.destinationFor(req);
    const s = this.session(dest);

    let csrfRetried = false;
    for (;;) {
      if (needsCsrf && !s.csrf) await this.fetchCsrf(req, dest, jwt, s);
      const res = await this.raw(req, dest, jwt, s, needsCsrf && s.csrf ? { 'x-csrf-token': s.csrf } : {});

      if (res.status === 403 && needsCsrf && !csrfRetried && (res.headers['x-csrf-token'] ?? '').toLowerCase() === 'required') {
        csrfRetried = true;
        s.csrf = undefined;
        continue;
      }

      log(method, adtPath(req.path), '→', res.status, `dest=${dest}`);
      if (res.status >= 400 && !req.allowError) {
        const msg = adtErrorMessage(res.body) ?? res.body.slice(0, 500);
        throw new AdtError(res.status, `ADT ${method} ${adtPath(req.path)} failed (${res.status}): ${msg}`, res.body);
      }
      return { status: res.status, headers: res.headers, body: res.body };
    }
  }

  get(path: string, opts: Omit<AdtRequest, 'path' | 'method'> = {}) {
    return this.request({ ...opts, path, method: 'GET' });
  }
  post(path: string, opts: Omit<AdtRequest, 'path' | 'method'> = {}) {
    return this.request({ ...opts, path, method: 'POST' });
  }
  put(path: string, opts: Omit<AdtRequest, 'path' | 'method'> = {}) {
    return this.request({ ...opts, path, method: 'PUT' });
  }
  delete(path: string, opts: Omit<AdtRequest, 'path' | 'method'> = {}) {
    return this.request({ ...opts, path, method: 'DELETE' });
  }
}

function decode(data: unknown): string {
  if (data === undefined || data === null) return '';
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  return JSON.stringify(data);
}

function lowerKeys(h: Record<string, string>): Record<string, string> {
  const o: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) o[k.toLowerCase()] = v;
  return o;
}
