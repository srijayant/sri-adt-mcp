import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: true,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
});

export function parseXml(xml: string): any {
  if (!xml || !xml.trimStart().startsWith('<')) return undefined;
  try {
    return parser.parse(xml);
  } catch {
    return undefined;
  }
}

export function esc(s: string | number | undefined): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function arr<T>(v: T | T[] | undefined): T[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

/** Depth-first collect of every node with the given (namespace-stripped) tag name. */
export function findAll(node: any, tag: string, out: any[] = []): any[] {
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === tag) out.push(...arr(v as any));
      if (v && typeof v === 'object') arr(v as any).forEach((c) => findAll(c, tag, out));
    }
  }
  return out;
}

/** Keep only @attributes of a node as a flat object with the "@" stripped. */
export function attrs(node: any): Record<string, string> {
  const o: Record<string, string> = {};
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) if (k.startsWith('@') && !k.startsWith('@xmlns')) o[k.slice(1)] = String(v);
  }
  return o;
}

export const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>';

export function objectReferences(uris: Array<{ uri: string; name?: string }>): string {
  return `${XML_HEADER}
<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">
${uris.map((u) => `  <adtcore:objectReference adtcore:uri="${esc(u.uri)}"${u.name ? ` adtcore:name="${esc(u.name.toUpperCase())}"` : ''}/>`).join('\n')}
</adtcore:objectReferences>`;
}

export function lockHandle(xml: string): string | undefined {
  return xml.match(/<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/)?.[1];
}

export function corrNr(xml: string): string | undefined {
  return xml.match(/<CORRNR>([^<]*)<\/CORRNR>/)?.[1] || undefined;
}

/** Summarise activation / check messages from ADT chkl / msg XML. */
export function messages(xml: string): Array<Record<string, string>> {
  const doc = parseXml(xml);
  if (!doc) return [];
  const out: Array<Record<string, string>> = [];
  for (const m of [...findAll(doc, 'msg'), ...findAll(doc, 'checkMessage')]) {
    const a = attrs(m);
    const text = m?.shortText?.txt ?? m?.shortText ?? a.shortText ?? m?.['#text'];
    out.push({ ...a, ...(text ? { text: typeof text === 'string' ? text : JSON.stringify(text) } : {}) });
  }
  return out;
}
