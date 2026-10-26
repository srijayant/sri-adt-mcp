import { z } from 'zod';
import { tool, destinationArg } from './registry.js';
import { objectArgs } from './objectArgs.js';
import { objectUri, fullUri } from '../adt/uri.js';
import { attrs, esc, findAll, parseXml } from '../adt/xml.js';

const TREE = 'application/vnd.sap.adt.transportorganizertree.v1+xml';
const asx = (data: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DATA>${data}</DATA></asx:values></asx:abap>`;

function summarize(xml: string) {
  return findAll(parseXml(xml), 'request').map((r: any) => ({
    ...attrs(r),
    tasks: findAll(r, 'task').map((t: any) => ({
      ...attrs(t),
      objects: findAll(t, 'abap_object').map(attrs),
    })),
    objects: findAll(r.all_objects ?? {}, 'abap_object').map(attrs),
  }));
}

export const transportTools = [
  tool({
    name: 'list_transports',
    description: 'List transport requests of a user (default: the technical/current user), with tasks.',
    schema: {
      user: z.string().optional(),
      status: z.enum(['modifiable', 'released', 'all']).default('modifiable'),
      ...destinationArg,
    },
    handler: async (a, { client }) => {
      const r = await client.get('/cts/transportrequests', {
        query: {
          user: a.user?.toUpperCase(),
          targets: true,
          requestStatus: a.status === 'modifiable' ? 'D' : a.status === 'released' ? 'R' : undefined,
        },
        accept: TREE,
        destination: a.destination,
      });
      return summarize(r.body);
    },
  }),

  tool({
    name: 'get_transport',
    description: 'Details of one transport request: tasks, owner, status, all objects.',
    schema: { number: z.string(), raw: z.boolean().optional(), ...destinationArg },
    handler: async (a, { client }) => {
      const r = await client.get(`/cts/transportrequests/${a.number.toUpperCase()}`, { accept: TREE, destination: a.destination });
      return a.raw ? r.body : summarize(r.body);
    },
  }),

  tool({
    name: 'get_transport_for_object',
    description:
      'Transport check for an object: is it local, is a transport required, which requests are available, is it already locked in one.',
    schema: { ...objectArgs, packageName: z.string().optional(), ...destinationArg },
    handler: async (a, { client }) => {
      const r = await client.post('/cts/transportchecks', {
        contentType: 'application/vnd.sap.as+xml; charset=UTF-8; dataname=com.sap.adt.transport.service.checkData',
        accept: 'application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.transport.service.checkData',
        body: asx(
          `<PGMID/><OBJECT/><OBJECTNAME/><DEVCLASS>${esc(a.packageName?.toUpperCase() ?? '')}</DEVCLASS><SUPER_PACKAGE/><OPERATION>I</OPERATION><URI>${esc(fullUri(objectUri(a)))}</URI>`,
        ),
        destination: a.destination,
      });
      const d = findAll(parseXml(r.body), 'DATA')[0] ?? {};
      return {
        recording: d.RECORDING,
        dlvunit: d.DLVUNIT,
        devclass: d.DEVCLASS,
        lockedIn: findAll(d.LOCKS ?? {}, 'CTS_OBJECT_LOCK').map((l: any) => l.LOCK_HOLDER?.REQ_HEADER?.TRKORR ?? l),
        requests: findAll(d.REQUESTS ?? {}, 'CTS_REQUEST').map((q: any) => ({
          number: q.REQ_HEADER?.TRKORR,
          text: q.REQ_HEADER?.AS4TEXT,
          owner: q.REQ_HEADER?.AS4USER,
        })),
        messages: findAll(d, 'CTS_MESSAGE'),
      };
    },
  }),

  tool({
    name: 'create_transport',
    description: 'Create a workbench transport request for an object/package. Returns the request number.',
    write: true,
    schema: {
      text: z.string().max(60),
      packageName: z.string(),
      ...objectArgs,
      ...destinationArg,
    },
    handler: async (a, { client }) => {
      const ref = a.uri || a.name ? fullUri(objectUri(a)) : fullUri(`/packages/${encodeURIComponent(a.packageName.toLowerCase())}`);
      const r = await client.post('/cts/transports', {
        contentType: 'application/vnd.sap.as+xml; charset=UTF-8; dataname=com.sap.adt.CreateCorrectionRequest',
        accept: 'text/plain',
        body: asx(
          `<OPERATION>I</OPERATION><DEVCLASS>${esc(a.packageName.toUpperCase())}</DEVCLASS><REQUEST_TEXT>${esc(a.text)}</REQUEST_TEXT><REF>${esc(ref)}</REF>`,
        ),
        destination: a.destination,
      });
      return { transport: r.body.trim().split('/').pop() };
    },
  }),

  tool({
    name: 'release_transport',
    description: 'Release a transport request or task. With releaseTasks=true, open tasks are released first.',
    write: true,
    schema: { number: z.string(), releaseTasks: z.boolean().default(true), ...destinationArg },
    handler: async (a, { client }) => {
      const nr = a.number.toUpperCase();
      const out: Array<{ number: string; result: string }> = [];
      const rel = async (n: string) => {
        const r = await client.post(`/cts/transportrequests/${n}/newreleasejobs`, {
          accept: 'application/vnd.sap.adt.transportorganizer.v1+xml',
          destination: a.destination,
        });
        const rep = findAll(parseXml(r.body), 'releasereport').map(attrs)[0];
        out.push({ number: n, result: rep ? `${rep.status ?? ''} ${rep.statusText ?? ''}`.trim() : r.body.slice(0, 500) });
      };
      if (a.releaseTasks) {
        const tree = await client.get(`/cts/transportrequests/${nr}`, { accept: TREE, destination: a.destination });
        for (const t of findAll(parseXml(tree.body), 'task').map(attrs)) {
          if (t.number && t.number !== nr && t.status !== 'R') await rel(t.number);
        }
      }
      await rel(nr);
      return out;
    },
  }),

  tool({
    name: 'delete_transport',
    description: 'Delete a (modifiable) transport request or task.',
    write: true,
    schema: { number: z.string(), ...destinationArg },
    handler: async (a, { client }) => {
      await client.delete(`/cts/transportrequests/${a.number.toUpperCase()}`, { destination: a.destination });
      return `Deleted ${a.number.toUpperCase()}`;
    },
  }),

  tool({
    name: 'change_transport_owner',
    description: 'Change the owner of a transport request or task.',
    write: true,
    schema: { number: z.string(), newOwner: z.string(), ...destinationArg },
    handler: async (a, { client }) =>
      (
        await client.put(`/cts/transportrequests/${a.number.toUpperCase()}`, {
          query: { _action: 'changeowner', targetuser: a.newOwner.toUpperCase() },
          accept: 'application/*',
          destination: a.destination,
        })
      ).body,
  }),

  tool({
    name: 'add_user_to_transport',
    description: 'Add a user to a transport request (creates a task for them).',
    write: true,
    schema: { number: z.string(), user: z.string(), ...destinationArg },
    handler: async (a, { client }) =>
      (
        await client.post(`/cts/transportrequests/${a.number.toUpperCase()}/tasks`, {
          contentType: 'text/plain',
          accept: 'application/*',
          body: `<?xml version="1.0" encoding="ASCII"?><tm:root xmlns:tm="http://www.sap.com/cts/adt/tm" tm:number="${esc(a.number.toUpperCase())}" tm:targetuser="${esc(a.user.toUpperCase())}" tm:useraction="newtask"/>`,
          destination: a.destination,
        })
      ).body,
  }),
];
