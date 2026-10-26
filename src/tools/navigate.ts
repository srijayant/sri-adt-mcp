import { z } from 'zod';
import { tool, destinationArg } from './registry.js';
import { objectArgs } from './objectArgs.js';
import { objectUri, sourceUri, fullUri, TYPES } from '../adt/uri.js';
import { attrs, esc, findAll, parseXml, XML_HEADER } from '../adt/xml.js';

const refList = (xml: string) => findAll(parseXml(xml), 'objectReference').map(attrs);

export const navigateTools = [
  tool({
    name: 'search_objects',
    description: 'Search the ABAP repository (quick search, wildcards * allowed). Optionally filter by object type and package.',
    schema: {
      query: z.string().describe('Name pattern, e.g. ZCL_*SALES*'),
      objectType: z.string().optional().describe('e.g. CLAS, PROG, DDLS or full ADT type CLAS/OC'),
      packageName: z.string().optional(),
      maxResults: z.number().int().min(1).max(1000).default(50),
      ...destinationArg,
    },
    handler: async (a, { client }) => {
      const t = a.objectType?.toUpperCase();
      const r = await client.get('/repository/informationsystem/search', {
        query: {
          operation: 'quickSearch',
          query: a.query,
          maxResults: a.maxResults,
          objectType: t ? (TYPES[t]?.adtType ?? t) : undefined,
          packageName: a.packageName,
        },
        accept: 'application/xml',
        destination: a.destination,
      });
      return refList(r.body);
    },
  }),

  tool({
    name: 'get_object_properties',
    description: 'Read object metadata (description, package, responsible, created/changed, language, version, links).',
    schema: { ...objectArgs, raw: z.boolean().optional(), ...destinationArg },
    handler: async (a, { client }) => {
      const r = await client.get(objectUri(a), { accept: 'application/*', destination: a.destination });
      if (a.raw) return r.body;
      const doc = parseXml(r.body);
      const root = doc && Object.values(doc).find((v) => v && typeof v === 'object');
      return { ...attrs(root), links: findAll(doc, 'link').map(attrs).map((l) => ({ rel: l.rel, href: l.href, type: l.type })) };
    },
  }),

  tool({
    name: 'get_object_structure',
    description: 'Outline of an object: methods, attributes, types, sections, includes, with source positions.',
    schema: { ...objectArgs, ...destinationArg },
    handler: async (a, { client }) =>
      (
        await client.get(`${objectUri(a)}/objectstructure`, {
          accept: 'application/vnd.sap.adt.objectstructure.v2+xml, application/xml',
          destination: a.destination,
        })
      ).body,
  }),

  tool({
    name: 'get_package_contents',
    description: 'List objects in a package (or any repository node) — the ADT Project Explorer tree.',
    schema: {
      packageName: z.string(),
      parentType: z.string().default('DEVC/K'),
      ...destinationArg,
    },
    handler: async (a, { client }) => {
      const r = await client.post('/repository/nodestructure', {
        query: { parent_type: a.parentType, parent_name: a.packageName.toUpperCase(), withShortDescriptions: true },
        accept: 'application/vnd.sap.as+xml',
        destination: a.destination,
      });
      return findAll(parseXml(r.body), 'SEU_ADT_REPOSITORY_OBJ_NODE').map((n: any) => ({
        type: n.OBJECT_TYPE,
        name: n.OBJECT_NAME,
        uri: n.OBJECT_URI,
        description: n.DESCRIPTION,
        expandable: n.EXPANDABLE,
      }));
    },
  }),

  tool({
    name: 'where_used',
    description: 'Where-used list for an object (usage references). Optionally fetch code snippets for each usage.',
    schema: { ...objectArgs, snippets: z.boolean().optional(), ...destinationArg },
    handler: async (a, { client }) => {
      const uri = fullUri(objectUri(a));
      const r = await client.post('/repository/informationsystem/usageReferences', {
        query: { uri },
        contentType: 'application/vnd.sap.adt.repository.usagereferences.request.v1+xml',
        accept: 'application/vnd.sap.adt.repository.usagereferences.result.v1+xml',
        body: `${XML_HEADER}<usagereferences:usageReferenceRequest xmlns:usagereferences="http://www.sap.com/adt/ris/usageReferences"><usagereferences:affectedObjects/></usagereferences:usageReferenceRequest>`,
        destination: a.destination,
      });
      const refs: Array<Record<string, string>> = findAll(parseXml(r.body), 'referencedObject').map((o: any) => ({
        ...attrs(o),
        ...attrs(o.adtObject),
        package: attrs(o.adtObject?.packageRef).name,
      }));
      if (!a.snippets) return refs;
      const ids = refs.map((x) => x.objectIdentifier).filter(Boolean);
      if (!ids.length) return refs;
      const s = await client.post('/repository/informationsystem/usageSnippets', {
        contentType: 'application/vnd.sap.adt.repository.usagesnippets.request.v1+xml',
        accept: 'application/vnd.sap.adt.repository.usagesnippets.result.v1+xml',
        body: `${XML_HEADER}<usagereferences:usageSnippetRequest xmlns:usagereferences="http://www.sap.com/adt/ris/usageReferences"><usagereferences:objectIdentifiers>${ids
          .map((i) => `<usagereferences:objectIdentifier optional="false">${esc(i)}</usagereferences:objectIdentifier>`)
          .join('')}</usagereferences:objectIdentifiers><usagereferences:affectedObjects/></usagereferences:usageSnippetRequest>`,
        destination: a.destination,
        allowError: true,
      });
      return { references: refs, snippets: s.body };
    },
  }),

  tool({
    name: 'find_definition',
    description: 'Navigate to definition of the token at line/column in an object source (F3 in ADT).',
    schema: {
      ...objectArgs,
      include: z.string().optional().describe('Class include (main, definitions, implementations, testclasses, macros)'),
      line: z.number().int().min(1),
      column: z.number().int().min(0),
      source: z.string().optional().describe('Current (possibly unsaved) source; defaults to the saved source'),
      ...destinationArg,
    },
    handler: async (a, { client }) => {
      const src = sourceUri(a);
      const body = a.source ?? (await client.get(src, { accept: 'text/plain', destination: a.destination })).body;
      const r = await client.post('/navigation/target', {
        query: { uri: `${fullUri(src)}#start=${a.line},${a.column}`, filter: 'definition' },
        contentType: 'text/plain',
        accept: 'application/xml',
        body,
        destination: a.destination,
      });
      return refList(r.body);
    },
  }),

  tool({
    name: 'get_type_hierarchy',
    description: 'Super- or sub-types of the class/interface token at line/column.',
    schema: {
      ...objectArgs,
      line: z.number().int().min(1),
      column: z.number().int().min(0),
      direction: z.enum(['superTypes', 'subTypes']).default('subTypes'),
      ...destinationArg,
    },
    handler: async (a, { client }) => {
      const src = sourceUri(a);
      const body = (await client.get(src, { accept: 'text/plain', destination: a.destination })).body;
      const r = await client.post('/abapsource/typehierarchy', {
        query: { uri: `${fullUri(src)}#start=${a.line},${a.column}`, type: a.direction },
        contentType: 'text/plain',
        accept: 'application/xml',
        body,
        destination: a.destination,
      });
      return findAll(parseXml(r.body), 'entry').map(attrs);
    },
  }),

  tool({
    name: 'list_object_versions',
    description: 'Version history of an object source (active, inactive, transported versions).',
    schema: { ...objectArgs, include: z.string().optional(), ...destinationArg },
    handler: async (a, { client }) => {
      const r = await client.get(`${sourceUri(a)}/versions`, {
        accept: 'application/atom+xml;type=feed',
        destination: a.destination,
      });
      return findAll(parseXml(r.body), 'entry').map((e: any) => ({
        id: e.id,
        title: typeof e.title === 'string' ? e.title : e.title?.['#text'],
        updated: e.updated,
        author: e.author?.name,
        href: attrs([].concat(e.content ?? e.link ?? [])[0]).src ?? findAll(e, 'link').map(attrs)[0]?.href,
      }));
    },
  }),

  tool({
    name: 'get_version_source',
    description: 'Fetch the source of a specific version (href from list_object_versions).',
    schema: { href: z.string(), ...destinationArg },
    handler: async (a, { client }) => (await client.get(a.href, { accept: 'text/plain', destination: a.destination })).body,
  }),
];
