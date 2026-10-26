import type { AdtClient } from '../http/adtClient.js';
import { fullUri } from './uri.js';
import { messages, objectReferences } from './xml.js';

export interface ActivationResult {
  success: boolean;
  messages: Array<Record<string, string>>;
  raw?: string;
}

export async function activate(
  client: AdtClient,
  objs: Array<{ uri: string; name?: string }>,
  destination?: string,
): Promise<ActivationResult> {
  const r = await client.post('/activation', {
    query: { method: 'activate', preauditRequested: true },
    contentType: 'application/xml',
    accept: 'application/xml',
    body: objectReferences(objs.map((o) => ({ uri: fullUri(o.uri), name: o.name }))),
    destination,
  });
  const msgs = messages(r.body);
  const hasError = msgs.some((m) => /^[EAX]$/.test(m.type ?? '') || m.severity === 'error');
  const inactive = /inactiveObjects|ioc:entry/.test(r.body);
  return {
    success: !hasError && !inactive,
    messages: msgs,
    raw: msgs.length || inactive ? r.body : undefined,
  };
}
