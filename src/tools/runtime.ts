import { z } from 'zod';
import { tool, destinationArg } from './registry.js';
import { encName } from '../adt/uri.js';
import { arr, attrs, findAll, parseXml } from '../adt/xml.js';

const DP_ACCEPT = 'application/xml, application/vnd.sap.adt.datapreview.table.v1+xml';

function previewRows(xml: string) {
  const doc = parseXml(xml);
  const cols = findAll(doc, 'columns');
  const names = cols.map((c: any) => attrs(c.metadata).name ?? attrs(c.metadata).description);
  const values = cols.map((c: any) => arr(c.dataSet?.data).map((v: any) => (typeof v === 'object' ? v['#text'] ?? '' : v)));
  const n = Math.max(0, ...values.map((v) => v.length));
  const rows = Array.from({ length: n }, (_, i) => Object.fromEntries(names.map((nm, j) => [nm, values[j][i]])));
  const total = findAll(doc, 'totalRows')[0];
  return { totalRows: typeof total === 'object' ? total['#text'] : total, columns: names, rows };
}

export const runtimeTools = [
  tool({
    name: 'run_class',
    description: 'Run a class implementing IF_OO_ADT_CLASSRUN (F9 in ADT) and return its console output.',
    write: true,
    schema: { className: z.string(), ...destinationArg },
    handler: async (a, { client }) =>
      (await client.post(`/oo/classrun/${encName(a.className)}`, { accept: 'text/plain', destination: a.destination })).body,
  }),

  tool({
    name: 'data_preview',
    description: 'Data preview of a table, view or CDS entity (like F8 in ADT), with optional WHERE clause and row limit.',
    schema: {
      entity: z.string().describe('Table / CDS entity name'),
      where: z.string().optional().describe('ABAP SQL condition, e.g. "carrid = \'LH\'"'),
      rows: z.number().int().min(1).max(5000).default(100),
      ...destinationArg,
    },
    handler: async (a, { client }) => {
      const e = a.entity.toUpperCase();
      const r = await client.post('/datapreview/ddic', {
        query: { rowNumber: a.rows, ddicEntityName: e },
        contentType: 'text/plain',
        accept: DP_ACCEPT,
        body: `SELECT * FROM ${e}${a.where ? ` WHERE ${a.where}` : ''}`,
        destination: a.destination,
      });
      return previewRows(r.body);
    },
  }),

  tool({
    name: 'run_sql',
    description: 'Run a freestyle ABAP SQL SELECT (SQL console in ADT). Read-only SELECTs only.',
    schema: { sql: z.string(), rows: z.number().int().min(1).max(5000).default(100), ...destinationArg },
    handler: async (a, { client }) => {
      if (!/^\s*(select|with)\b/i.test(a.sql)) throw new Error('Only SELECT / WITH statements are allowed');
      const r = await client.post('/datapreview/freestyle', {
        query: { rowNumber: a.rows },
        contentType: 'text/plain',
        accept: DP_ACCEPT,
        body: a.sql,
        destination: a.destination,
      });
      return previewRows(r.body);
    },
  }),

  tool({
    name: 'list_dumps',
    description: 'List ABAP runtime errors / short dumps (ST22).',
    schema: {
      user: z.string().optional().describe('Filter by user'),
      max: z.number().int().default(50),
      ...destinationArg,
    },
    handler: async (a, { client }) => {
      const r = await client.get('/runtime/dumps', {
        query: { '$top': a.max, '$query': a.user ? `and( equals( user, ${a.user.toUpperCase()} ) )` : undefined },
        accept: 'application/atom+xml;type=feed',
        destination: a.destination,
      });
      return findAll(parseXml(r.body), 'entry').map((e: any) => ({
        title: typeof e.title === 'string' ? e.title : e.title?.['#text'],
        updated: e.updated,
        author: e.author?.name,
        categories: arr(e.category).map((c: any) => attrs(c).term),
        links: findAll(e, 'link').map(attrs).map((l) => ({ rel: l.rel, href: l.href, type: l.type })),
      }));
    },
  }),

  tool({
    name: 'get_dump',
    description: 'Get a short dump in detail (href from list_dumps).',
    schema: { href: z.string(), ...destinationArg },
    handler: async (a, { client }) =>
      (await client.get(a.href, { accept: 'text/plain, application/vnd.sap.adt.runtime.dump.v1+xml, */*', destination: a.destination })).body,
  }),

  tool({
    name: 'list_traces',
    description: 'List ABAP profiler traces (SAT) of the user.',
    schema: { user: z.string().optional(), ...destinationArg },
    handler: async (a, { client }) => {
      const r = await client.get('/runtime/traces/abaptraces', {
        query: { user: a.user?.toUpperCase() },
        accept: 'application/atom+xml;type=feed',
        destination: a.destination,
      });
      return findAll(parseXml(r.body), 'entry').map((e: any) => ({
        id: e.id,
        title: typeof e.title === 'string' ? e.title : e.title?.['#text'],
        updated: e.updated,
        links: findAll(e, 'link').map(attrs).map((l) => ({ rel: l.rel, href: l.href })),
      }));
    },
  }),

  tool({
    name: 'get_trace',
    description: 'Analyse a profiler trace: hitlist, dbAccesses or statements.',
    schema: {
      traceId: z.string().describe('Trace id or full trace URI from list_traces'),
      view: z.enum(['hitlist', 'dbAccesses', 'statements']).default('hitlist'),
      ...destinationArg,
    },
    handler: async (a, { client }) => {
      const base = a.traceId.includes('/') ? a.traceId : `/runtime/traces/abaptraces/${encodeURIComponent(a.traceId)}`;
      return (await client.get(`${base}/${a.view}`, { accept: 'application/xml', destination: a.destination })).body;
    },
  }),
];
