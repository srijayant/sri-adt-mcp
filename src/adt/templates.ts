import { esc, XML_HEADER } from './xml.js';
import { encName, fullUri } from './uri.js';

export interface CreateSpec {
  type: string;
  name: string;
  description: string;
  packageName: string;
  responsible?: string;
  language?: string;
  group?: string;
  superClass?: string;
  mainProgram?: string;
  superPackage?: string;
  softwareComponent?: string;
  transportLayer?: string;
  serviceDefinition?: string;
  bindingType?: 'V2' | 'V4';
  bindingCategory?: '0' | '1';
}

// [root tag, ns prefix, ns uri, adt type]
const ROOTS: Record<string, [string, string, string, string]> = {
  PROG: ['abapProgram', 'program', 'http://www.sap.com/adt/programs/programs', 'PROG/P'],
  INCL: ['abapInclude', 'include', 'http://www.sap.com/adt/programs/includes', 'PROG/I'],
  CLAS: ['abapClass', 'class', 'http://www.sap.com/adt/oo/classes', 'CLAS/OC'],
  INTF: ['abapInterface', 'intf', 'http://www.sap.com/adt/oo/interfaces', 'INTF/OI'],
  FUGR: ['abapFunctionGroup', 'group', 'http://www.sap.com/adt/functions/groups', 'FUGR/F'],
  FUNC: ['abapFunctionModule', 'fmodule', 'http://www.sap.com/adt/functions/fmodules', 'FUGR/FF'],
  DDLS: ['ddlSource', 'ddl', 'http://www.sap.com/adt/ddic/ddlsources', 'DDLS/DF'],
  DCLS: ['dclSource', 'dcl', 'http://www.sap.com/adt/acm/dclsources', 'DCLS/DL'],
  DDLX: ['ddlxSource', 'ddlx', 'http://www.sap.com/adt/ddic/ddlxsources', 'DDLX/EX'],
  BDEF: ['blueSource', 'blue', 'http://www.sap.com/wbobj/blue', 'BDEF/BDO'],
  SRVD: ['srvdSource', 'srvd', 'http://www.sap.com/adt/ddic/srvdsources', 'SRVD/SRV'],
  SRVB: ['serviceBinding', 'srvb', 'http://www.sap.com/adt/ddic/ServiceBindings', 'SRVB/SVB'],
  TABL: ['blueSource', 'blue', 'http://www.sap.com/wbobj/blue', 'TABL/DT'],
  STRU: ['blueSource', 'blue', 'http://www.sap.com/wbobj/blue', 'TABL/DS'],
  DTEL: ['wbobj', 'blue', 'http://www.sap.com/wbobj/dictionary/dtel', 'DTEL/DE'],
  DOMA: ['domain', 'doma', 'http://www.sap.com/dictionary/domain', 'DOMA/DD'],
  MSAG: ['messageClass', 'mc', 'http://www.sap.com/adt/MessageClass', 'MSAG/N'],
  DEVC: ['package', 'pak', 'http://www.sap.com/adt/packages', 'DEVC/K'],
};

export const CREATABLE = Object.keys(ROOTS);

/** Collection to POST the create request to. */
export function createCollection(s: CreateSpec, collection: string): string {
  if (s.type === 'FUNC') return `/functions/groups/${encName(s.group!)}/fmodules`;
  return collection;
}

export function createBody(s: CreateSpec): string {
  const r = ROOTS[s.type];
  if (!r) throw new Error(`create not supported for ${s.type}; supported: ${CREATABLE.join(', ')} (use adt_request for others)`);
  const [tag, p, ns, adtType] = r;
  const name = s.name.toUpperCase();
  const attrs = [
    `adtcore:description="${esc(s.description)}"`,
    `adtcore:name="${esc(name)}"`,
    `adtcore:type="${adtType}"`,
    `adtcore:masterLanguage="${esc(s.language ?? 'EN')}"`,
    s.responsible ? `adtcore:responsible="${esc(s.responsible.toUpperCase())}"` : '',
  ];
  let inner = '';
  switch (s.type) {
    case 'CLAS':
      attrs.push(`${p}:final="true"`, `${p}:visibility="public"`);
      if (s.superClass) inner += `<${p}:superClassRef adtcore:name="${esc(s.superClass.toUpperCase())}"/>`;
      break;
    case 'INCL':
      if (s.mainProgram) {
        const mp = s.mainProgram.toUpperCase();
        inner += `<${p}:containerRef adtcore:name="${esc(mp)}" adtcore:type="PROG/P" adtcore:uri="${fullUri(`/programs/programs/${encName(mp)}`)}"/>`;
      }
      break;
    case 'FUNC': {
      if (!s.group) throw new Error('FUNC requires group');
      const g = s.group.toUpperCase();
      inner += `<adtcore:containerRef adtcore:name="${esc(g)}" adtcore:type="FUGR/F" adtcore:uri="${fullUri(`/functions/groups/${encName(g)}`)}"/>`;
      return `${XML_HEADER}<${p}:${tag} xmlns:${p}="${ns}" xmlns:adtcore="http://www.sap.com/adt/core" ${attrs.join(' ')}>${inner}</${p}:${tag}>`;
    }
    case 'SRVD':
      attrs.push(`${p}:srvdSourceType="S"`);
      break;
    case 'SRVB': {
      if (!s.serviceDefinition) throw new Error('SRVB requires serviceDefinition');
      inner +=
        `<${p}:services ${p}:name="${esc(name)}"><${p}:content ${p}:version="0001"><${p}:serviceDefinition adtcore:name="${esc(s.serviceDefinition.toUpperCase())}"/></${p}:content></${p}:services>` +
        `<${p}:binding ${p}:type="ODATA" ${p}:version="${s.bindingType ?? 'V4'}" ${p}:category="${s.bindingCategory ?? '0'}"><${p}:implementation adtcore:name=""/></${p}:binding>`;
      break;
    }
    case 'DEVC':
      inner +=
        `<${p}:attributes ${p}:packageType="development"/>` +
        (s.superPackage ? `<${p}:superPackage adtcore:name="${esc(s.superPackage.toUpperCase())}"/>` : '') +
        `<${p}:transport><${p}:softwareComponent ${p}:name="${esc(s.softwareComponent ?? (s.packageName.startsWith('$') ? 'LOCAL' : 'HOME'))}"/>` +
        `<${p}:transportLayer ${p}:name="${esc(s.transportLayer ?? '')}"/></${p}:transport>`;
      break;
  }
  const pkg = s.type === 'DEVC' ? name : s.packageName.toUpperCase();
  inner = `<adtcore:packageRef adtcore:name="${esc(pkg)}"/>` + inner;
  return `${XML_HEADER}<${p}:${tag} xmlns:${p}="${ns}" xmlns:adtcore="http://www.sap.com/adt/core" ${attrs.filter(Boolean).join(' ')}>${inner}</${p}:${tag}>`;
}
