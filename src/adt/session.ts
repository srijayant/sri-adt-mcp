import type { AdtClient } from '../http/adtClient.js';
import { corrNr, lockHandle } from './xml.js';

export interface LockInfo {
  handle: string;
  transport?: string;
  raw: string;
}

const LOCK_ACCEPT =
  'application/*,application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.result;q=0.8, application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.result2;q=0.9';

export async function lock(client: AdtClient, uri: string, destination?: string): Promise<LockInfo> {
  const r = await client.post(uri, {
    query: { _action: 'LOCK', accessMode: 'MODIFY' },
    accept: LOCK_ACCEPT,
    stateful: true,
    destination,
  });
  const handle = lockHandle(r.body);
  if (!handle) throw new Error(`Lock returned no LOCK_HANDLE: ${r.body.slice(0, 300)}`);
  return { handle, transport: corrNr(r.body), raw: r.body };
}

export async function unlock(client: AdtClient, uri: string, handle: string, destination?: string): Promise<void> {
  await client.post(uri, {
    query: { _action: 'UNLOCK', lockHandle: handle },
    stateful: true,
    destination,
  });
}

/** Lock → fn → always unlock. */
export async function withLock<T>(
  client: AdtClient,
  uri: string,
  fn: (l: LockInfo) => Promise<T>,
  destination?: string,
): Promise<T> {
  const l = await lock(client, uri, destination);
  try {
    return await fn(l);
  } finally {
    try {
      await unlock(client, uri, l.handle, destination);
    } catch (e) {
      console.error('[sri-adt] unlock failed for', uri, (e as Error).message);
    }
  }
}
