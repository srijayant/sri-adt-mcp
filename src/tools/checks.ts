import { z } from 'zod';
import { tool, destinationArg } from './registry.js';
import { objectArgs } from './objectArgs.js';
import { objectUri, sourceUri, fullUri, CLASS_INCLUDES } from '../adt/uri.js';
import { activate } from '../adt/activation.js';
import { attrs, esc, findAll, parseXml, XML_HEADER } from '../adt/xml.js';

const includeArg = { include: z.enum(CLASS_INCLUDES).optional() };
const posArgs = { line: z.number().int().min(1), column: z.number().int().min(0) };

export const checkTools = [
  tool({
    name: 'activate',
    description: 'Activate one or more objects (mass activation). Returns errors/warnings if activation fails.',
    write: true,
    schema: {
      objects: z
        .array(z.object(objectArgs))
        .min(1)
        .describe('Objects to activate, each {type,name} or {uri}'),
      ...destinationArg,
    },
    handler: (a, { client }) =>
      activate(client, a.objects.map((o) => ({ uri: objectUri(o), name: o.name })), a.destination),
  }),

  tool({
    name: 'get_inactive_objects',
    description: 'List inactive (saved but not activated) objects of the current user.',
    schema: { ...destinationArg },
    handler: async (a, { client }) => {
      const r = await client.get('/activation/inactiveobjects', {
        accept: 'application/vnd.sap.adt.inactivectsobjects.v1+xml, application/xml',
        destination: a.destination,
      });
      return findAll(parseXml(r.body), 'object').map((o: any) => ({ ...attrs(o), ...attrs(o.ref) }));
    },
  }),

  tool({
    name: 'syntax_check',
    description:
      'Syntax check an object. Pass `source` to check unsaved code; otherwise the saved (inactive/active) version is checked.',
    schema: {
      ...objectArgs,
      ...includeArg,
      source: z.string().optional(),
      version: z.enum(['active', 'inactive']).default('inactive'),
      ...destinationArg,
    },
    handler: async (a, { client }) => {
      const obj = fullUri(objectUri(a));
      const src = fullUri(sourceUri(a));
      const artifact = a.source
        ? `<chkrun:artifacts><chkrun:artifact chkrun:contentType="text/plain; charset=utf-8" chkrun:uri="${esc(src)}"><chkrun:content>${Buffer.from(a.source, 'utf8').toString('base64')}</chkrun:content></chkrun:artifact></chkrun:artifacts>`
        : '';
      const r = await client.post('/checkruns', {
        query: { reporters: 'abapCheckRun' },
        contentType: 'application/vnd.sap.adt.checkobjects+xml',
        accept: 'application/vnd.sap.adt.checkmessages+xml',
        body: `${XML_HEADER}<chkrun:checkObjectList xmlns:chkrun="http://www.sap.com/adt/checkrun" xmlns:adtcore="http://www.sap.com/adt/core"><chkrun:checkObject adtcore:uri="${esc(obj)}" chkrun:version="${a.version}">${artifact}</chkrun:checkObject></chkrun:checkObjectList>`,
        destination: a.destination,
      });
      const msgs = findAll(parseXml(r.body), 'checkMessage').map((m: any) => {
        const x = attrs(m);
        const pos = x.uri?.match(/#start=(\d+),(\d+)/);
        return { type: x.type, text: x.shortText, line: pos ? +pos[1] : undefined, column: pos ? +pos[2] : undefined, uri: x.uri };
      });
      return msgs.length ? msgs : 'No syntax errors.';
    },
  }),

  tool({
    name: 'pretty_print',
    description: 'Format ABAP source with the backend Pretty Printer settings. Returns formatted source (does not save).',
    schema: { source: z.string(), ...destinationArg },
    handler: async (a, { client }) =>
      (
        await client.post('/abapsource/prettyprinter', {
          contentType: 'text/plain; charset=utf-8',
          accept: 'text/plain',
          body: a.source,
          destination: a.destination,
        })
      ).body,
  }),

  tool({
    name: 'code_completion',
    description: 'Code completion proposals at line/column (Ctrl+Space in ADT).',
    schema: { ...objectArgs, ...includeArg, ...posArgs, source: z.string().optional(), ...destinationArg },
    handler: async (a, { client }) => {
      const src = sourceUri(a);
      const body = a.source ?? (await client.get(src, { accept: 'text/plain', destination: a.destination })).body;
      const r = await client.post('/abapsource/codecompletion/proposal', {
        query: { uri: `${fullUri(src)}#start=${a.line},${a.column}`, signalCompleteness: true },
        contentType: 'application/*',
        accept: 'application/*',
        body,
        destination: a.destination,
      });
      return findAll(parseXml(r.body), 'SCC_COMPLETION').map((c: any) => ({ identifier: c.IDENTIFIER, kind: c.KIND, locationUri: c.LOCATION }));
    },
  }),

  tool({
    name: 'quickfix_proposals',
    description: 'Quick-fix proposals (Ctrl+1) for the position in the source.',
    schema: { ...objectArgs, ...includeArg, ...posArgs, source: z.string().optional(), ...destinationArg },
    handler: async (a, { client }) => {
      const src = sourceUri(a);
      const body = a.source ?? (await client.get(src, { accept: 'text/plain', destination: a.destination })).body;
      const r = await client.post('/quickfixes/evaluation', {
        query: { uri: `${fullUri(src)}#start=${a.line},${a.column}` },
        contentType: 'application/*',
        accept: 'application/*',
        body,
        destination: a.destination,
      });
      return findAll(parseXml(r.body), 'entry').map((e: any) => ({
        ...attrs(e.object),
        name: e.object?.name ?? e.name,
        description: e.object?.description ?? e.description,
        proposalUri: attrs(findAll(e, 'link')[0]).href ?? attrs(e.object).uri,
        userContent: e.userContent,
      }));
    },
  }),

  tool({
    name: 'apply_quickfix',
    description: 'Apply a quick-fix proposal (from quickfix_proposals). Returns the source deltas to apply; does not save.',
    write: true,
    schema: {
      ...objectArgs,
      ...includeArg,
      ...posArgs,
      proposalUri: z.string(),
      userContent: z.string().default(''),
      source: z.string().optional(),
      ...destinationArg,
    },
    handler: async (a, { client }) => {
      const src = sourceUri(a);
      const source = a.source ?? (await client.get(src, { accept: 'text/plain', destination: a.destination })).body;
      const r = await client.post(a.proposalUri, {
        contentType: 'application/*',
        accept: 'application/*',
        body: `${XML_HEADER}<quickfixes:proposalRequest xmlns:quickfixes="http://www.sap.com/adt/quickfixes" xmlns:adtcore="http://www.sap.com/adt/core"><input><content>${esc(source)}</content><adtcore:objectReference adtcore:uri="${esc(`${fullUri(src)}#start=${a.line},${a.column}`)}"/></input><userContent>${esc(a.userContent)}</userContent></quickfixes:proposalRequest>`,
        destination: a.destination,
      });
      return r.body;
    },
  }),
];
