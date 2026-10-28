import { describe, it, expect } from 'vitest';
import { objectUri, sourceUri } from '../src/adt/uri.js';
import { createBody } from '../src/adt/templates.js';
import { adtPath, AdtClient, type Executor } from '../src/http/adtClient.js';
import { requireUser, IdentityError } from '../src/auth/identity.js';
import { loadConfig, packageAllowed, resolveUserDestination } from '../src/config.js';

describe('uri', () => {
  it('maps types', () => {
    expect(objectUri({ type: 'CLAS', name: 'ZCL_Foo' })).toBe('/oo/classes/zcl_foo');
    expect(objectUri({ type: 'FUNC', name: 'Z_FM', group: 'ZFG' })).toBe('/functions/groups/zfg/fmodules/z_fm');
    expect(objectUri({ type: 'PROG', name: '/ABC/REP' })).toBe('/programs/programs/%2Fabc%2Frep');
    expect(sourceUri({ type: 'CLAS', name: 'ZCL_X', include: 'testclasses' })).toBe('/oo/classes/zcl_x/includes/testclasses');
    expect(sourceUri({ type: 'DDLS', name: 'ZI_X' })).toBe('/ddic/ddl/sources/zi_x/source/main');
    expect(sourceUri({ uri: '/sap/bc/adt/oo/classes/zcl_x/source/main' })).toBe('/oo/classes/zcl_x/source/main');
  });
  it('normalises paths', () => {
    expect(adtPath('/sap/bc/adt/oo/classes/x')).toBe('/oo/classes/x');
    expect(adtPath('oo/classes/x')).toBe('/oo/classes/x');
    expect(adtPath('https://host:443/sap/bc/adt/discovery')).toBe('/discovery');
  });
});

describe('templates', () => {
  it('builds class create body', () => {
    const b = createBody({ type: 'CLAS', name: 'zcl_a', description: 'A & B', packageName: '$tmp' });
    expect(b).toContain('adtcore:name="ZCL_A"');
    expect(b).toContain('adtcore:description="A &amp; B"');
    expect(b).toContain('<adtcore:packageRef adtcore:name="$TMP"/>');
  });
  it('function module has container, no package', () => {
    const b = createBody({ type: 'FUNC', name: 'z_fm', description: 'x', packageName: '$TMP', group: 'zfg' });
    expect(b).toContain('adtcore:type="FUGR/F"');
    expect(b).not.toContain('packageRef');
  });
});

describe('config', () => {
  it('requires a destination', () => {
    expect(() => loadConfig({} as any)).toThrow(/SRI_ADT_DESTINATION/);
  });
  it('allowlists and package patterns', () => {
    const cfg = loadConfig({ SRI_ADT_DESTINATION: 'S4', SRI_ADT_DESTINATIONS: 'S4Q, S4', SRI_ADT_ALLOWED_PACKAGES: 'Z*,$TMP' } as any);
    expect(cfg.allowedDestinations).toEqual(['S4', 'S4Q']);
    expect(packageAllowed(cfg, 'ZSALES')).toBe(true);
    expect(packageAllowed(cfg, '$tmp')).toBe(true);
    expect(packageAllowed(cfg, 'SAPX')).toBe(false);
  });

  it('per-user destinations: explicit map wins, then template, and feed the allowlist', () => {
    const cfg = loadConfig({
      SRI_ADT_DESTINATION: 'S4',
      SRI_ADT_USER_DESTINATIONS: '{"sri.jayant@bsci.com":"adt_dest_sri"}',
      SRI_ADT_USER_DESTINATION_TEMPLATE: 'adt_dest_{user}',
    } as any);
    expect(resolveUserDestination(cfg, 'sri.jayant@bsci.com')).toBe('adt_dest_sri'); // explicit map
    expect(resolveUserDestination(cfg, 'SRI.JAYANT@bsci.com')).toBe('adt_dest_sri'); // case-insensitive
    expect(resolveUserDestination(cfg, 'rahul@bsci.com')).toBe('adt_dest_rahul'); // template, local part
    expect(resolveUserDestination(cfg, undefined)).toBeUndefined();
    expect(cfg.allowedDestinations).toContain('adt_dest_sri'); // mapped dests are auto-allowed
  });

  it('per-user destinations: k=v syntax and no-mapping fallback', () => {
    const cfg = loadConfig({ SRI_ADT_DESTINATION: 'S4', SRI_ADT_USER_DESTINATIONS: 'a@x=d_a, b@x=d_b' } as any);
    expect(resolveUserDestination(cfg, 'a@x')).toBe('d_a');
    expect(resolveUserDestination(cfg, 'nobody@x')).toBeUndefined(); // no template → caller falls back to default
  });
});

describe('identity', () => {
  it('rejects technical tokens and accepts users', () => {
    expect(() => requireUser({ getGrantType: () => 'client_credentials' })).toThrow(IdentityError);
    expect(() => requireUser({ getGrantType: () => 'authorization_code', getLogonName: () => '' })).toThrow(IdentityError);
    expect(requireUser({ getGrantType: () => 'authorization_code', getLogonName: () => 'dev@example.com' }).user).toBe('dev@example.com');
  });
});

describe('AdtClient via destination', () => {
  const cfg = loadConfig({ SRI_ADT_DESTINATION: 'S4', SRI_ADT_DESTINATIONS: 'S4Q' } as any);

  it('fetches CSRF, retries on expired token, keeps cookies, passes user jwt', async () => {
    const calls: Array<{ dest: any; req: any }> = [];
    let csrfIssued = 0;
    const execute: Executor = async (dest, req) => {
      calls.push({ dest, req });
      if (req.url === '/sap/bc/adt/discovery') {
        csrfIssued++;
        return { status: 200, headers: { 'x-csrf-token': `tok${csrfIssued}`, 'set-cookie': ['SAP_SESSIONID=abc; path=/'] }, data: Buffer.from('') };
      }
      if (req.headers['x-csrf-token'] === 'tok1') return { status: 403, headers: { 'x-csrf-token': 'Required' }, data: Buffer.from('') };
      return { status: 200, headers: { 'content-type': 'application/xml' }, data: Buffer.from('<ok/>') };
    };
    const c = new AdtClient(cfg, () => 'user-jwt', { execute });
    const r = await c.post('/activation', { body: '<x/>', query: { method: 'activate' } });
    expect(r.body).toBe('<ok/>');
    expect(csrfIssued).toBe(2);
    const last = calls.at(-1)!;
    expect(last.dest).toEqual({ destinationName: 'S4', jwt: 'user-jwt' });
    expect(last.req.url).toBe('/sap/bc/adt/activation?method=activate');
    expect(last.req.headers['x-csrf-token']).toBe('tok2');
    expect(last.req.headers.cookie).toContain('SAP_SESSIONID=abc');
  });

  it('enforces the destination allowlist before calling out', async () => {
    let called = false;
    const c = new AdtClient(cfg, () => 'jwt', { execute: async () => ((called = true), { status: 200, headers: {}, data: '' }) });
    await expect(c.get('/discovery', { destination: 'PROD' })).rejects.toThrow(/not allowed/);
    await c.get('/discovery', { destination: 'S4Q' });
    expect(called).toBe(true);
  });

  it('throws readable ADT error', async () => {
    const execute: Executor = async () => ({
      status: 404,
      headers: {},
      data: Buffer.from('<exc:exception xmlns:exc="x"><localizedMessage lang="EN">Object ZX does not exist</localizedMessage></exc:exception>'),
    });
    const c = new AdtClient(cfg, () => 'jwt', { execute });
    await expect(c.get('/oo/classes/zx')).rejects.toThrow(/Object ZX does not exist/);
  });
});
