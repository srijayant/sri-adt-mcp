import { z } from 'zod';
import { tool, destinationArg } from './registry.js';
import { objectArgs } from './objectArgs.js';
import { objectUri, fullUri } from '../adt/uri.js';
import { arr, attrs, esc, findAll, parseXml, XML_HEADER } from '../adt/xml.js';

const objectsArg = {
  objects: z.array(z.object(objectArgs)).min(1).describe('Objects, each {type,name} or {uri} (packages allowed: DEVC)'),
};

function objectSet(uris: string[]): string {
  return `<objectSets xmlns:adtcore="http://www.sap.com/adt/core"><objectSet kind="inclusive"><adtcore:objectReferences>${uris
    .map((u) => `<adtcore:objectReference adtcore:uri="${esc(fullUri(u))}"/>`)
    .join('')}</adtcore:objectReferences></objectSet></objectSets>`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const qualityTools = [
  tool({
    name: 'run_atc',
    description:
      'Run ABAP Test Cockpit (ATC) checks on objects or packages and return findings (priority, check, message, location). ' +
      'Uses the system default check variant unless one is given.',
    write: true,
    schema: {
      ...objectsArg,
      checkVariant: z.string().optional(),
      maxVerdicts: z.number().int().default(200),
      includeExempted: z.boolean().default(false),
      ...destinationArg,
    },
    handler: async (a, { client }) => {
      const d = a.destination;
      let variant = a.checkVariant;
      if (!variant) {
        const c = await client.get('/atc/customizing', { accept: 'application/xml', destination: d });
        variant =
          findAll(parseXml(c.body), 'property')
            .map(attrs)
            .find((p) => p.name === 'systemCheckVariant')?.value ?? 'DEFAULT';
      }
      const wl = await client.post('/atc/worklists', { query: { checkVariant: variant }, accept: 'text/plain', destination: d });
      const worklistId = wl.body.trim();
      await client.post('/atc/runs', {
        query: { worklistId },
        contentType: 'application/xml',
        accept: 'application/xml',
        body: `${XML_HEADER}<atc:run xmlns:atc="http://www.sap.com/adt/atc" maximumVerdicts="${a.maxVerdicts}">${objectSet(a.objects.map(objectUri))}</atc:run>`,
        destination: d,
      });
      let body = '';
      for (let i = 0; i < 30; i++) {
        const r = await client.get(`/atc/worklists/${encodeURIComponent(worklistId)}`, {
          query: { includeExemptedFindings: a.includeExempted },
          accept: 'application/atc.worklist.v1+xml',
          destination: d,
        });
        body = r.body;
        if (!/objectSetIsComplete="false"/.test(body)) break;
        await sleep(2000);
      }
      const findings: Array<Record<string, unknown>> = [];
      for (const o of findAll(parseXml(body), 'object')) {
        const oa = attrs(o);
        for (const f of findAll(o, 'finding')) {
          const fa = attrs(f);
          const pos = fa.location?.match(/#start=(\d+),(\d+)/);
          findings.push({
            object: `${oa.type} ${oa.name}`,
            priority: fa.priority,
            check: fa.checkTitle,
            message: fa.messageTitle,
            location: fa.location,
            line: pos ? +pos[1] : undefined,
            exemptionApproval: fa.exemptionApproval || undefined,
          });
        }
      }
      return { checkVariant: variant, worklistId, count: findings.length, findings };
    },
  }),

  tool({
    name: 'get_atc_worklist',
    description: 'Fetch an existing ATC worklist (findings) by ID.',
    schema: { worklistId: z.string(), includeExempted: z.boolean().default(false), ...destinationArg },
    handler: async (a, { client }) =>
      (
        await client.get(`/atc/worklists/${encodeURIComponent(a.worklistId)}`, {
          query: { includeExemptedFindings: a.includeExempted },
          accept: 'application/atc.worklist.v1+xml',
          destination: a.destination,
        })
      ).body,
  }),

  tool({
    name: 'get_atc_customizing',
    description: 'ATC configuration: default check variant, exemption reasons.',
    schema: { ...destinationArg },
    handler: async (a, { client }) => (await client.get('/atc/customizing', { accept: 'application/xml', destination: a.destination })).body,
  }),

  tool({
    name: 'run_unit_tests',
    description: 'Run ABAP Unit tests for classes, programs, function groups or packages. Returns per-method results, alerts and optional coverage.',
    write: true,
    schema: {
      ...objectsArg,
      coverage: z.boolean().default(false),
      riskLevels: z.array(z.enum(['harmless', 'dangerous', 'critical'])).default(['harmless', 'dangerous', 'critical']),
      durations: z.array(z.enum(['short', 'medium', 'long'])).default(['short', 'medium', 'long']),
      ...destinationArg,
    },
    handler: async (a, { client }) => {
      const has = (list: string[], k: string) => String(list.includes(k));
      const body =
        `${XML_HEADER}<aunit:runConfiguration xmlns:aunit="http://www.sap.com/adt/aunit">` +
        `<external><coverage active="${a.coverage}"/></external>` +
        `<options><uriType value="semantic"/><testDeterminationStrategy sameProgram="true" assignedTests="false"/>` +
        `<testRiskLevels harmless="${has(a.riskLevels, 'harmless')}" dangerous="${has(a.riskLevels, 'dangerous')}" critical="${has(a.riskLevels, 'critical')}"/>` +
        `<testDurations short="${has(a.durations, 'short')}" medium="${has(a.durations, 'medium')}" long="${has(a.durations, 'long')}"/>` +
        `<withNavigationUri enabled="true"/></options>` +
        objectSet(a.objects.map(objectUri)).replace('<objectSets', '<adtcore:objectSets').replace('</objectSets>', '</adtcore:objectSets>') +
        `</aunit:runConfiguration>`;
      const r = await client.post('/abapunit/testruns', {
        contentType: 'application/*',
        accept: 'application/*',
        body,
        destination: a.destination,
      });
      const doc = parseXml(r.body);
      const results: Array<Record<string, unknown>> = [];
      for (const cls of findAll(doc, 'testClass')) {
        const ca = attrs(cls);
        const classAlerts = arr(cls.alerts?.alert).map((al: any) => ({ kind: attrs(al).kind, severity: attrs(al).severity, title: al.title }));
        for (const m of findAll(cls, 'testMethod')) {
          const ma = attrs(m);
          const alerts = findAll(m, 'alert').map((al: any) => ({
            kind: attrs(al).kind,
            severity: attrs(al).severity,
            title: al.title,
            details: findAll(al, 'detail').map((x: any) => attrs(x).text).filter(Boolean),
          }));
          results.push({
            class: ca.name,
            method: ma.name,
            status: alerts.length ? 'FAILED' : 'OK',
            executionTime: ma.executionTime,
            alerts: alerts.length ? alerts : undefined,
          });
        }
        if (classAlerts.length) results.push({ class: ca.name, classAlerts });
      }
      const failed = results.filter((x) => x.status === 'FAILED').length;
      return { total: results.filter((x) => x.method).length, failed, results, coverage: a.coverage ? findAll(doc, 'coverage').map(attrs) : undefined };
    },
  }),
];
