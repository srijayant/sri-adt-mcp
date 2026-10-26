import { z } from 'zod';
import { tool, destinationArg, assertPackage } from './registry.js';
import { objectUri, sourceUri, TYPES, encName } from '../adt/uri.js';
import { CREATABLE, createBody, createCollection } from '../adt/templates.js';
import { withLock } from '../adt/session.js';
import { activate } from '../adt/activation.js';
import { esc } from '../adt/xml.js';

export const createTools = [
  tool({
    name: 'create_object',
    description:
      `Create a repository object (${CREATABLE.join(', ')}). Optionally write initial source and activate. ` +
      'Use packageName "$TMP" for local objects; non-local packages need a transport.',
    write: true,
    schema: {
      type: z.enum(CREATABLE as [string, ...string[]]),
      name: z.string(),
      description: z.string().max(60),
      packageName: z.string().default('$TMP'),
      transport: z.string().optional(),
      source: z.string().optional().describe('Initial source (for source-based objects)'),
      activate: z.boolean().default(false),
      responsible: z.string().optional(),
      group: z.string().optional().describe('FUNC: function group'),
      superClass: z.string().optional().describe('CLAS: superclass'),
      mainProgram: z.string().optional().describe('INCL: main program'),
      superPackage: z.string().optional().describe('DEVC: parent package'),
      softwareComponent: z.string().optional().describe('DEVC: e.g. HOME, LOCAL, ZCUSTOM'),
      transportLayer: z.string().optional().describe('DEVC'),
      serviceDefinition: z.string().optional().describe('SRVB: service definition'),
      bindingType: z.enum(['V2', 'V4']).optional().describe('SRVB OData version'),
      bindingCategory: z.enum(['0', '1']).optional().describe('SRVB: 0 = UI, 1 = Web API'),
      ...destinationArg,
    },
    handler: async (a, ctx) => {
      assertPackage(ctx, a.packageName);
      const collection = a.type === 'FUNC' ? '' : TYPES[a.type].collection;
      await ctx.client.post(createCollection(a, collection), {
        query: { corrNr: a.transport },
        contentType: 'application/*',
        accept: 'application/*',
        body: createBody(a),
        destination: a.destination,
      });
      const ref = { type: a.type, name: a.name, group: a.group };
      const uri = objectUri(ref);
      const result: Record<string, unknown> = { created: uri };
      if (a.source) {
        await withLock(
          ctx.client,
          uri,
          (l) =>
            ctx.client.put(sourceUri(ref), {
              query: { lockHandle: l.handle, corrNr: a.transport ?? l.transport },
              contentType: 'text/plain; charset=utf-8',
              body: a.source,
              stateful: true,
              destination: a.destination,
            }),
          a.destination,
        );
        result.sourceWritten = true;
      }
      if (a.activate) result.activation = await activate(ctx.client, [{ uri, name: a.name }], a.destination);
      return result;
    },
  }),

  tool({
    name: 'create_class_include',
    description: 'Create a class include (testclasses, definitions, implementations, macros) so it can be written.',
    write: true,
    schema: {
      className: z.string(),
      includeType: z.enum(['testclasses', 'definitions', 'implementations', 'macros']),
      transport: z.string().optional(),
      ...destinationArg,
    },
    handler: async (a, ctx) => {
      const uri = `/oo/classes/${encName(a.className)}`;
      await withLock(
        ctx.client,
        uri,
        (l) =>
          ctx.client.post(`${uri}/includes`, {
            query: { lockHandle: l.handle, corrNr: a.transport ?? l.transport },
            contentType: 'application/*',
            body: `<?xml version="1.0" encoding="UTF-8"?><class:abapClassInclude xmlns:class="http://www.sap.com/adt/oo/classes" xmlns:adtcore="http://www.sap.com/adt/core" adtcore:name="${esc(a.className.toUpperCase())}" class:includeType="${a.includeType}"/>`,
            stateful: true,
            destination: a.destination,
          }),
        a.destination,
      );
      return `Created include ${a.includeType} of ${a.className.toUpperCase()}`;
    },
  }),

  tool({
    name: 'upsert_message',
    description: 'Create or change a message text in a message class (SE91).',
    write: true,
    schema: {
      messageClass: z.string(),
      number: z.string().regex(/^\d{1,3}$/),
      text: z.string().max(73),
      transport: z.string().optional(),
      ...destinationArg,
    },
    handler: async (a, ctx) => {
      const uri = `/messageclass/${encName(a.messageClass)}`;
      const no = a.number.padStart(3, '0');
      const cur = (await ctx.client.get(uri, { accept: 'application/*', destination: a.destination })).body;
      const existing = new RegExp(`(<(\\w+:)?messages\\b[^>]*\\bmsgno="${no}"[^>]*\\bmsgtext=")[^"]*(")`);
      const existing2 = new RegExp(`(<(\\w+:)?messages\\b[^>]*\\bmsgtext=")[^"]*("[^>]*\\bmsgno="${no}")`);
      let next: string;
      if (existing.test(cur)) next = cur.replace(existing, `$1${esc(a.text)}$3`);
      else if (existing2.test(cur)) next = cur.replace(existing2, `$1${esc(a.text)}$3`);
      else {
        const prefix = cur.match(/<(\w+):messageClass\b/)?.[1] ?? 'mc';
        next = cur.replace(
          new RegExp(`</${prefix}:messageClass>`),
          `<${prefix}:messages ${prefix}:msgno="${no}" ${prefix}:msgtext="${esc(a.text)}" ${prefix}:selfexplainatory="true"/></${prefix}:messageClass>`,
        );
      }
      await withLock(
        ctx.client,
        uri,
        (l) =>
          ctx.client.put(uri, {
            query: { lockHandle: l.handle, corrNr: a.transport ?? l.transport },
            contentType: 'application/vnd.sap.adt.mc.messageclass+xml',
            body: next,
            stateful: true,
            destination: a.destination,
          }),
        a.destination,
      );
      return `Message ${a.messageClass.toUpperCase()}/${no} saved.`;
    },
  }),
];
