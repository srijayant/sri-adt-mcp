import { z } from 'zod';
import { tool, destinationArg } from './registry.js';
import { objectArgs } from './objectArgs.js';
import { encName, sourceUri, fullUri, objectUri, CLASS_INCLUDES } from '../adt/uri.js';
import { attrs, findAll, parseXml, objectReferences } from '../adt/xml.js';

export const serviceTools = [
  tool({
    name: 'get_service_binding',
    description: 'Service binding details: OData version, services, versions, publish state, entity sets and URLs.',
    schema: { name: z.string(), ...destinationArg },
    handler: async (a, { client }) =>
      (
        await client.get(`/businessservices/bindings/${encName(a.name)}`, {
          accept: 'application/vnd.sap.adt.businessservices.servicebinding.v2+xml, application/*',
          destination: a.destination,
        })
      ).body,
  }),

  tool({
    name: 'publish_service_binding',
    description: 'Publish or unpublish an OData service binding (the Publish button in ADT).',
    write: true,
    schema: {
      name: z.string().describe('Service binding name'),
      serviceName: z.string().optional().describe('Service name inside the binding; defaults to binding name'),
      serviceVersion: z.string().default('0001'),
      odataVersion: z.enum(['V2', 'V4']).default('V4'),
      unpublish: z.boolean().default(false),
      ...destinationArg,
    },
    handler: async (a, { client }) => {
      const v = a.odataVersion === 'V2' ? 'odatav2' : 'odatav4';
      const r = await client.post(`/businessservices/${v}/${a.unpublish ? 'unpublishjobs' : 'publishjobs'}`, {
        query: { servicename: (a.serviceName ?? a.name).toUpperCase(), serviceversion: a.serviceVersion },
        contentType: 'application/xml',
        accept: 'application/xml',
        body: objectReferences([{ uri: fullUri(`/businessservices/bindings/${encName(a.name)}`), name: a.name }]),
        destination: a.destination,
      });
      const d = findAll(parseXml(r.body), 'DATA')[0];
      return d ? { severity: d.SEVERITY, text: d.SHORT_TEXT, long: d.LONG_TEXT } : r.body;
    },
  }),

  tool({
    name: 'get_ddic_element',
    description: 'DDIC / CDS element info: fields, types, associations, annotations of a table or CDS entity.',
    schema: { name: z.string().describe('Entity path, e.g. I_PRODUCT or I_PRODUCT._TEXT'), ...destinationArg },
    handler: async (a, { client }) =>
      (
        await client.get('/ddic/ddl/elementinfo', {
          query: { getTargetForAssociation: false, getExtensionViews: true, getSecondaryObjects: true, path: a.name.toLowerCase() },
          accept: 'application/vnd.sap.adt.elementinfo+xml',
          destination: a.destination,
        })
      ).body,
  }),

  tool({
    name: 'get_cds_annotation_definitions',
    description: 'All CDS annotation definitions known to the system (large).',
    schema: { ...destinationArg },
    handler: async (a, { client }) =>
      (
        await client.get('/ddic/cds/annotation/definitions', {
          accept: 'application/vnd.sap.adt.cds.annotation.definitions.v1+xml, application/vnd.sap.adt.cds.annotation.definitions.v2+xml',
          destination: a.destination,
        })
      ).body,
  }),

  tool({
    name: 'abap_documentation',
    description: 'ABAP keyword / element documentation (F1) for the token at line/column.',
    schema: {
      ...objectArgs,
      include: z.enum(CLASS_INCLUDES).optional(),
      line: z.number().int().min(1),
      column: z.number().int().min(0),
      language: z.string().default('EN'),
      ...destinationArg,
    },
    handler: async (a, { client }) => {
      const src = sourceUri(a);
      const body = (await client.get(src, { accept: 'text/plain', destination: a.destination })).body;
      return (
        await client.post('/docu/abap/langu', {
          query: { uri: `${fullUri(src)}#start=${a.line},${a.column}`, language: a.language, format: 'eclipse' },
          contentType: 'text/plain',
          accept: 'application/vnd.sap.adt.docu.v1+html, text/html',
          body,
          destination: a.destination,
        })
      ).body;
    },
  }),

  tool({
    name: 'get_enhancement',
    description:
      'Read an enhancement object: BAdI implementation (ENHO/XHH), enhancement spot (ENHS/XSB), or source-code enhancement (kind=source, returns its source).',
    schema: {
      name: z.string(),
      kind: z.enum(['badiImpl', 'spot', 'source']).default('badiImpl'),
      ...destinationArg,
    },
    handler: async (a, { client }) => {
      const base = { badiImpl: '/enhancements/enhoxhh', spot: '/enhancements/enhsxsb', source: '/enhancements/enhoxh' }[a.kind];
      const path = `${base}/${encName(a.name)}${a.kind === 'source' ? '/source/main' : ''}`;
      return (await client.get(path, { accept: a.kind === 'source' ? 'text/plain' : 'application/*', destination: a.destination })).body;
    },
  }),

  tool({
    name: 'get_badi_implementations',
    description: 'Find BAdI implementations (ENHO) of an enhancement spot via where-used.',
    schema: { spot: z.string(), ...destinationArg },
    handler: async (a, { client }) => {
      const uri = fullUri(objectUri({ type: 'ENHS', name: a.spot }));
      const r = await client.post('/repository/informationsystem/usageReferences', {
        query: { uri },
        contentType: 'application/vnd.sap.adt.repository.usagereferences.request.v1+xml',
        accept: 'application/vnd.sap.adt.repository.usagereferences.result.v1+xml',
        body: '<?xml version="1.0" encoding="UTF-8"?><usagereferences:usageReferenceRequest xmlns:usagereferences="http://www.sap.com/adt/ris/usageReferences"><usagereferences:affectedObjects/></usagereferences:usageReferenceRequest>',
        destination: a.destination,
      });
      return findAll(parseXml(r.body), 'adtObject')
        .map(attrs)
        .filter((o) => (o.type ?? '').startsWith('ENHO'));
    },
  }),
];
