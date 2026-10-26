import { z } from 'zod';
import { tool, destinationArg, assertPackage, type Ctx } from './registry.js';
import { objectArgs } from './objectArgs.js';
import { objectUri, sourceUri, fullUri, CLASS_INCLUDES } from '../adt/uri.js';
import { lock, unlock, withLock } from '../adt/session.js';
import { activate } from '../adt/activation.js';
import { attrs, findAll, parseXml } from '../adt/xml.js';

const includeArg = {
  include: z.enum(CLASS_INCLUDES).optional().describe('Class include; default main'),
};

/** Look up the package of an object (only when a package allowlist is configured). */
async function checkObjectPackage(ctx: Ctx, uri: string, destination?: string) {
  if (!ctx.cfg.allowedPackages.length) return;
  const r = await ctx.client.get(uri, { accept: 'application/*', destination });
  const pkg = attrs(findAll(parseXml(r.body), 'packageRef')[0]).name;
  assertPackage(ctx, pkg);
}

export const sourceTools = [
  tool({
    name: 'read_source',
    description:
      'Read source code of any ABAP object: program, include, class (+ includes), interface, function module, CDS (DDLS/DCLS/DDLX/BDEF/SRVD/DDLA), table/structure, transformation.',
    schema: {
      ...objectArgs,
      ...includeArg,
      version: z.enum(['active', 'inactive', 'workingArea']).optional(),
      ...destinationArg,
    },
    handler: async (a, { client }) =>
      (
        await client.get(sourceUri(a), {
          query: { version: a.version },
          accept: 'text/plain',
          destination: a.destination,
        })
      ).body,
  }),

  tool({
    name: 'write_source',
    description:
      'Replace the full source of an object: lock → write → unlock, optionally activate. Use `transport` for non-$TMP objects.',
    write: true,
    schema: {
      ...objectArgs,
      ...includeArg,
      source: z.string().describe('Complete new source text'),
      transport: z.string().optional().describe('Transport request (e.g. DS4K900123)'),
      activate: z.boolean().default(true),
      ...destinationArg,
    },
    handler: async (a, ctx) => {
      const uri = objectUri(a);
      await checkObjectPackage(ctx, uri, a.destination);
      const src = sourceUri(a);
      await withLock(
        ctx.client,
        uri,
        (l) =>
          ctx.client.put(src, {
            query: { lockHandle: l.handle, corrNr: a.transport ?? l.transport },
            contentType: 'text/plain; charset=utf-8',
            body: a.source,
            stateful: true,
            destination: a.destination,
          }),
        a.destination,
      );
      if (!a.activate) return { written: src, activated: false };
      const act = await activate(ctx.client, [{ uri, name: a.name }], a.destination);
      return { written: src, activation: act };
    },
  }),

  tool({
    name: 'lock_object',
    description:
      'Lock an object for editing (stateful session). Returns the lock handle; pass it to adt_request writes and unlock_object. Prefer write_source, which handles locking.',
    write: true,
    schema: { ...objectArgs, ...destinationArg },
    handler: async (a, { client }) => {
      const l = await lock(client, objectUri(a), a.destination);
      return { lockHandle: l.handle, transport: l.transport };
    },
  }),

  tool({
    name: 'unlock_object',
    description: 'Release a lock taken with lock_object.',
    write: true,
    schema: { ...objectArgs, lockHandle: z.string(), ...destinationArg },
    handler: async (a, { client }) => {
      await unlock(client, objectUri(a), a.lockHandle, a.destination);
      return 'Unlocked.';
    },
  }),

  tool({
    name: 'delete_object',
    description: 'Delete a repository object (lock → DELETE). Requires transport for non-$TMP objects.',
    write: true,
    schema: { ...objectArgs, transport: z.string().optional(), ...destinationArg },
    handler: async (a, ctx) => {
      const uri = objectUri(a);
      await checkObjectPackage(ctx, uri, a.destination);
      const l = await lock(ctx.client, uri, a.destination);
      try {
        await ctx.client.delete(uri, {
          query: { lockHandle: l.handle, corrNr: a.transport ?? l.transport },
          stateful: true,
          destination: a.destination,
        });
      } catch (e) {
        await unlock(ctx.client, uri, l.handle, a.destination).catch(() => {});
        throw e;
      }
      return `Deleted ${uri}`;
    },
  }),

  tool({
    name: 'rename_symbol',
    description:
      'Rename refactoring for the identifier at line/column (variables, methods, classes …). Returns the preview; set execute=true to apply.',
    write: true,
    schema: {
      ...objectArgs,
      ...includeArg,
      line: z.number().int().min(1),
      startColumn: z.number().int().min(0),
      endColumn: z.number().int().min(0),
      newName: z.string(),
      transport: z.string().optional(),
      execute: z.boolean().default(false),
      ...destinationArg,
    },
    handler: async (a, { client }) => {
      const rel = 'http://www.sap.com/adt/relations/refactoring/rename';
      const uri = `${fullUri(sourceUri(a))}#start=${a.line},${a.startColumn};end=${a.line},${a.endColumn}`;
      const common = { contentType: 'application/*', accept: 'application/*', destination: a.destination };
      const ev = await client.post('/refactorings', { ...common, query: { step: 'evaluate', rel, uri } });
      let body = ev.body.replace(/<(\w+:)?newName>[^<]*<\/(\w+:)?newName>/, (_m, p1 = '', p2 = '') => `<${p1}newName>${a.newName}</${p2}newName>`);
      if (a.transport) body = body.replace(/<(\w+:)?transport>[^<]*<\/(\w+:)?transport>/, (_m, p1 = '', p2 = '') => `<${p1}transport>${a.transport}</${p2}transport>`);
      const pv = await client.post('/refactorings', { ...common, query: { step: 'preview', rel }, body });
      if (!a.execute) return { preview: pv.body };
      const ex = await client.post('/refactorings', { ...common, query: { step: 'execute' }, body: pv.body });
      return { executed: true, result: ex.body };
    },
  }),
];
