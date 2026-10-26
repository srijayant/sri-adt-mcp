/** Object-type → ADT URI mapping. URIs are relative to /sap/bc/adt. */

export interface TypeInfo {
  /** Collection path; object URI = `${collection}/${encodedName}`. */
  collection: string;
  /** True if the object has a text source at /source/main. */
  source: boolean;
  /** ADT object type used in create/search payloads (e.g. "CLAS/OC"). */
  adtType: string;
  description: string;
}

export const TYPES: Record<string, TypeInfo> = {
  PROG: { collection: '/programs/programs', source: true, adtType: 'PROG/P', description: 'Report / program' },
  INCL: { collection: '/programs/includes', source: true, adtType: 'PROG/I', description: 'Program include' },
  CLAS: { collection: '/oo/classes', source: true, adtType: 'CLAS/OC', description: 'Class' },
  INTF: { collection: '/oo/interfaces', source: true, adtType: 'INTF/OI', description: 'Interface' },
  FUGR: { collection: '/functions/groups', source: true, adtType: 'FUGR/F', description: 'Function group' },
  DDLS: { collection: '/ddic/ddl/sources', source: true, adtType: 'DDLS/DF', description: 'CDS data definition' },
  DCLS: { collection: '/acm/dcl/sources', source: true, adtType: 'DCLS/DL', description: 'CDS access control' },
  DDLX: { collection: '/ddic/ddlx/sources', source: true, adtType: 'DDLX/EX', description: 'CDS metadata extension' },
  BDEF: { collection: '/bo/behaviordefinitions', source: true, adtType: 'BDEF/BDO', description: 'RAP behavior definition' },
  SRVD: { collection: '/ddic/srvd/sources', source: true, adtType: 'SRVD/SRV', description: 'Service definition' },
  SRVB: { collection: '/businessservices/bindings', source: false, adtType: 'SRVB/SVB', description: 'Service binding' },
  TABL: { collection: '/ddic/tables', source: true, adtType: 'TABL/DT', description: 'Database table' },
  STRU: { collection: '/ddic/structures', source: true, adtType: 'TABL/DS', description: 'Structure' },
  TTYP: { collection: '/ddic/tabletypes', source: false, adtType: 'TTYP/DA', description: 'Table type' },
  DTEL: { collection: '/ddic/dataelements', source: false, adtType: 'DTEL/DE', description: 'Data element' },
  DOMA: { collection: '/ddic/domains', source: false, adtType: 'DOMA/DD', description: 'Domain' },
  MSAG: { collection: '/messageclass', source: false, adtType: 'MSAG/N', description: 'Message class' },
  DEVC: { collection: '/packages', source: false, adtType: 'DEVC/K', description: 'Package' },
  XSLT: { collection: '/xslt/transformations', source: true, adtType: 'XSLT/VT', description: 'Transformation (XSLT/ST)' },
  ENHO: { collection: '/enhancements/enhoxhh', source: false, adtType: 'ENHO/XHH', description: 'BAdI enhancement implementation' },
  ENHS: { collection: '/enhancements/enhsxsb', source: false, adtType: 'ENHS/XSB', description: 'BAdI enhancement spot' },
  DDLA: { collection: '/ddic/ddla/sources', source: true, adtType: 'DDLA/ADF', description: 'CDS annotation definition' },
  SAJC: { collection: '/applicationjob/catalogs', source: false, adtType: 'SAJC/SAJC', description: 'Application job catalog' },
};

export const TYPE_NAMES = Object.keys(TYPES) as [string, ...string[]];

/** Class includes available under /oo/classes/<name>/includes/<include>. */
export const CLASS_INCLUDES = ['main', 'definitions', 'implementations', 'macros', 'testclasses'] as const;

export function encName(name: string): string {
  return encodeURIComponent(name.trim().toLowerCase());
}

export interface ObjectRef {
  type?: string;
  name?: string;
  /** Function group — required for FUNC and function group includes. */
  group?: string;
  /** Explicit ADT URI; overrides type/name. */
  uri?: string;
}

/** Resolve an object reference to its ADT object URI (relative to /sap/bc/adt). */
export function objectUri(ref: ObjectRef): string {
  if (ref.uri) return ref.uri.replace(/^\/sap\/bc\/adt/i, '');
  const type = (ref.type ?? '').toUpperCase();
  const name = ref.name ?? '';
  if (!type || !name) throw new Error('Provide either `uri`, or `type` + `name`');
  if (type === 'FUNC') {
    if (!ref.group) throw new Error('FUNC requires `group` (function group name)');
    return `/functions/groups/${encName(ref.group)}/fmodules/${encName(name)}`;
  }
  if (type === 'FUGR_INCL') {
    if (!ref.group) throw new Error('FUGR_INCL requires `group`');
    return `/functions/groups/${encName(ref.group)}/includes/${encName(name)}`;
  }
  const t = TYPES[type];
  if (!t) throw new Error(`Unknown object type ${type}. Known: ${[...TYPE_NAMES, 'FUNC', 'FUGR_INCL'].join(', ')}`);
  return `${t.collection}/${encName(name)}`;
}

/** Source URI for an object; for classes an include may be chosen. */
export function sourceUri(ref: ObjectRef & { include?: string }): string {
  const base = objectUri(ref);
  if (ref.uri && /\/source\/|\/includes\//.test(ref.uri)) return base;
  const type = (ref.type ?? '').toUpperCase();
  if (type === 'CLAS' && ref.include && ref.include !== 'main') return `${base}/includes/${ref.include}`;
  return `${base}/source/main`;
}

/** Full /sap/bc/adt URI, as used inside XML payloads. */
export function fullUri(relUri: string): string {
  return relUri.startsWith('/sap/bc/adt') ? relUri : `/sap/bc/adt${relUri}`;
}
