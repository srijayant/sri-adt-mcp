import { z } from 'zod';
import { tool, destinationArg } from './registry.js';
import { objectArgs } from './objectArgs.js';
import { sourceUri, fullUri, CLASS_INCLUDES } from '../adt/uri.js';
import { esc } from '../adt/xml.js';

const IDE = 'sri-adt-mcp';
const VARS_CT = 'application/vnd.sap.as+xml; charset=UTF-8; dataname=com.sap.adt.debugger.Variables';
const CHILD_CT = 'application/vnd.sap.as+xml; charset=UTF-8; dataname=com.sap.adt.debugger.ChildVariables';
const asx = (data: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DATA>${data}</DATA></asx:values></asx:abap>`;

const userArg = {
  user: z.string().describe('Backend user whose sessions are debugged (usually the destination technical user)'),
};

export const debuggerTools = [
  tool({
    name: 'debugger_set_breakpoints',
    description:
      'Set external (user) breakpoints on source lines. Replaces the breakpoint set of this MCP client. Best-effort: debugging via HTTP is long-polling.',
    write: true,
    schema: {
      ...userArg,
      breakpoints: z
        .array(z.object({ ...objectArgs, include: z.enum(CLASS_INCLUDES).optional(), line: z.number().int().min(1) }))
        .describe('Empty array clears all breakpoints'),
      ...destinationArg,
    },
    handler: async (a, { client }) => {
      const bps = a.breakpoints
        .map((b, i) => `<breakpoint kind="line" clientId="bp${i}" skipCount="0" adtcore:uri="${esc(`${fullUri(sourceUri(b))}#start=${b.line}`)}"/>`)
        .join('');
      const r = await client.post('/debugger/breakpoints', {
        contentType: 'application/xml',
        accept: 'application/xml',
        stateful: true,
        body: `<?xml version="1.0" encoding="UTF-8"?><dbg:breakpoints xmlns:dbg="http://www.sap.com/adt/debugger" xmlns:adtcore="http://www.sap.com/adt/core" scope="external" debuggingMode="user" requestUser="${esc(a.user.toUpperCase())}" terminalId="${IDE}" ideId="${IDE}" systemDebugging="false" deactivated="false"><syncScope mode="full"/>${bps}</dbg:breakpoints>`,
        destination: a.destination,
      });
      return r.body;
    },
  }),

  tool({
    name: 'debugger_listen',
    description:
      'Wait (long poll, up to `timeout` s) for a session to hit a breakpoint. Returns the debuggee info (use debuggeeId with debugger_attach). Trigger the program separately.',
    write: true,
    schema: { ...userArg, timeout: z.number().int().min(1).max(80).default(60), ...destinationArg },
    handler: async (a, { client }) =>
      client.post('/debugger/listeners', {
        query: {
          debuggingMode: 'user',
          requestUser: a.user.toUpperCase(),
          terminalId: IDE,
          ideId: IDE,
          timeout: a.timeout,
          checkConflict: true,
          isNotifiedOnConflict: true,
        },
        accept: 'application/xml',
        destination: a.destination,
        allowError: true,
      }),
  }),

  tool({
    name: 'debugger_attach',
    description: 'Attach to a debuggee caught by debugger_listen.',
    write: true,
    schema: { ...userArg, debuggeeId: z.string(), ...destinationArg },
    handler: async (a, { client }) =>
      (
        await client.post('/debugger', {
          query: {
            method: 'attach',
            debuggeeId: a.debuggeeId,
            dynproDebugging: true,
            debuggingMode: 'user',
            requestUser: a.user.toUpperCase(),
          },
          accept: 'application/xml',
          stateful: true,
          destination: a.destination,
        })
      ).body,
  }),

  tool({
    name: 'debugger_step',
    description: 'Step in the attached debug session: stepInto, stepOver, stepReturn, stepContinue, terminateDebuggee.',
    write: true,
    schema: {
      step: z.enum(['stepInto', 'stepOver', 'stepReturn', 'stepContinue', 'terminateDebuggee']),
      ...destinationArg,
    },
    handler: async (a, { client }) =>
      (await client.post('/debugger', { query: { method: a.step }, accept: 'application/xml', stateful: true, destination: a.destination })).body,
  }),

  tool({
    name: 'debugger_stack',
    description: 'Call stack of the attached debug session.',
    write: true,
    schema: { ...destinationArg },
    handler: async (a, { client }) =>
      (
        await client.get('/debugger/stack', {
          query: { method: 'getStack', emode: '_', semanticURIs: true },
          accept: 'application/xml',
          stateful: true,
          destination: a.destination,
        })
      ).body,
  }),

  tool({
    name: 'debugger_variables',
    description:
      'Read variables in the attached session. Pass `names` (e.g. ["LV_X","LS_Y-FIELD"]) for values, or `parents` (e.g. ["@ROOT"], ["@LOCALS"]) to list children.',
    write: true,
    schema: {
      names: z.array(z.string()).optional(),
      parents: z.array(z.string()).optional(),
      ...destinationArg,
    },
    handler: async (a, { client }) => {
      if (a.parents?.length) {
        const r = await client.post('/debugger', {
          query: { method: 'getChildVariables' },
          contentType: CHILD_CT,
          accept: CHILD_CT,
          stateful: true,
          body: asx(`<HIERARCHIES>${a.parents.map((p) => `<STPDA_ADT_VARIABLE_HIERARCHY><PARENT_ID>${esc(p)}</PARENT_ID></STPDA_ADT_VARIABLE_HIERARCHY>`).join('')}</HIERARCHIES>`),
          destination: a.destination,
        });
        return r.body;
      }
      const r = await client.post('/debugger', {
        query: { method: 'getVariables' },
        contentType: VARS_CT,
        accept: VARS_CT,
        stateful: true,
        body: asx((a.names ?? []).map((n) => `<STPDA_ADT_VARIABLE><ID>${esc(n.toUpperCase())}</ID></STPDA_ADT_VARIABLE>`).join('')),
        destination: a.destination,
      });
      return r.body;
    },
  }),
];
