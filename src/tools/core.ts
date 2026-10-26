import { z } from 'zod';
import { tool, destinationArg } from './registry.js';
import { findAll, parseXml, attrs } from '../adt/xml.js';

export const coreTools = [
  tool({
    name: 'adt_request',
    description:
      'Universal ADT passthrough: call ANY endpoint under /sap/bc/adt with any method, headers and body. ' +
      'CSRF token + session cookies are handled automatically. Use this for any ADT feature without a dedicated tool. ' +
      'Path may be "/oo/classes/zcl_x" or "/sap/bc/adt/oo/classes/zcl_x".',
    write: true,
    schema: {
      method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD']).default('GET'),
      path: z.string().describe('ADT path, optionally including a query string'),
      query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
      headers: z.record(z.string()).optional().describe('Extra headers, e.g. {"Accept":"application/xml"}'),
      body: z.string().optional(),
      stateful: z.boolean().optional().describe('Send x-sap-adt-sessiontype: stateful (needed around locks)'),
      ...destinationArg,
    },
    handler: (a, { client }) =>
      client.request({
        method: a.method,
        path: a.path,
        query: a.query,
        headers: a.headers,
        body: a.body,
        stateful: a.stateful,
        destination: a.destination,
        allowError: true,
      }),
  }),

  tool({
    name: 'adt_get',
    description: 'Read-only ADT GET on any /sap/bc/adt path (available even in read-only mode).',
    schema: {
      path: z.string(),
      query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
      accept: z.string().optional(),
      ...destinationArg,
    },
    handler: (a, { client }) =>
      client.get(a.path, { query: a.query, accept: a.accept, destination: a.destination, allowError: true }),
  }),

  tool({
    name: 'adt_discovery',
    description:
      'List the ADT collections (endpoints) and accepted content types the backend supports. Use to check whether a feature exists on this system.',
    schema: {
      filter: z.string().optional().describe('Substring filter on href/title, e.g. "atc" or "cts"'),
      raw: z.boolean().optional().describe('Return raw ATOM XML'),
      ...destinationArg,
    },
    handler: async (a, { client }) => {
      const r = await client.get('/discovery', { accept: 'application/atomsvc+xml', destination: a.destination });
      if (a.raw) return r.body;
      const cols = findAll(parseXml(r.body), 'collection').map((c) => ({
        href: attrs(c).href,
        title: typeof c.title === 'string' ? c.title : c.title?.['#text'],
        accept: [].concat(c.accept ?? []).map((x: any) => (typeof x === 'string' ? x : x['#text'])),
      }));
      const f = a.filter?.toLowerCase();
      return f ? cols.filter((c) => `${c.href} ${c.title}`.toLowerCase().includes(f)) : cols;
    },
  }),

  tool({
    name: 'adt_reset_session',
    description: 'Drop cached CSRF token and session cookies (use if a stateful session got stuck).',
    schema: { ...destinationArg },
    handler: async (a, { client }) => {
      client.resetSession(a.destination);
      return 'Session reset.';
    },
  }),

  tool({
    name: 'adt_system_info',
    description: 'Backend system information (system ID, release, client, user) from /core/discovery and /system/information.',
    schema: { ...destinationArg },
    handler: async (a, { client }) => {
      const r = await client.get('/system/information', { accept: 'application/json', destination: a.destination, allowError: true });
      if (r.status < 400) return r.body;
      const u = await client.get('/core/discovery', { destination: a.destination, allowError: true });
      return { systemHeader: u.headers['sap-system'] ?? null, status: u.status };
    },
  }),
];
