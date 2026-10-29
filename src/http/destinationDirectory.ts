/** Resolves a signed-in user to a BTP destination by matching a custom additional property. */

export interface DestinationInfo {
  Name: string;
  [property: string]: string;
}

/** Lists the subaccount's destination configurations (names + properties, no secrets). */
export type DestinationLister = () => Promise<DestinationInfo[]>;

const log = (...a: unknown[]) => console.error('[sri-adt-dest]', ...a);

/** Reads the destination-service binding from VCAP_SERVICES. */
function destinationServiceCreds(): { clientid: string; clientsecret: string; uri: string; url: string } | undefined {
  try {
    const vcap = JSON.parse(process.env.VCAP_SERVICES ?? '{}');
    const c = (vcap.destination?.[0] ?? Object.values(vcap).flat().find((s: any) => s?.tags?.includes('destination')))?.credentials;
    if (c?.clientid && c?.clientsecret && c?.uri && c?.url) return c;
  } catch {
    /* ignore */
  }
  return undefined;
}

/** Default lister: client-credentials token from the destination service, then its subaccountDestinations endpoint. */
export const defaultLister: DestinationLister = async () => {
  const c = destinationServiceCreds();
  if (!c) throw new Error('No destination-service binding in VCAP_SERVICES');
  const tok = await fetch(`${c.url.replace(/\/+$/, '')}/oauth/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: 'Basic ' + Buffer.from(`${c.clientid}:${c.clientsecret}`).toString('base64'),
    },
    body: 'grant_type=client_credentials',
  });
  if (!tok.ok) throw new Error(`destination-service token failed (HTTP ${tok.status})`);
  const accessToken = ((await tok.json()) as { access_token?: string }).access_token;
  const r = await fetch(`${c.uri.replace(/\/+$/, '')}/destination-configuration/v1/subaccountDestinations`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) throw new Error(`subaccountDestinations failed (HTTP ${r.status})`);
  return (await r.json()) as DestinationInfo[];
};

export class DestinationDirectory {
  private cache?: { at: number; byUser: Map<string, string> };

  constructor(
    private property: string,
    private ttlMs = 5 * 60 * 1000,
    private lister: DestinationLister = defaultLister,
    /** If set, only destinations whose name starts with this prefix are considered. */
    private namePrefix?: string,
  ) {}

  /** Destination name whose `property` equals `user` (case-insensitive), or undefined. Refreshes once on a miss. */
  async destinationForUser(user: string): Promise<string | undefined> {
    const key = user.toLowerCase();
    const fresh = this.cache && Date.now() - this.cache.at < this.ttlMs;
    if (fresh) {
      const hit = this.cache!.byUser.get(key);
      if (hit) return hit;
    }
    await this.refresh();
    return this.cache!.byUser.get(key);
  }

  private async refresh(): Promise<void> {
    try {
      const list = await this.lister();
      const byUser = new Map<string, string>();
      for (const d of list) {
        if (this.namePrefix && !d.Name?.startsWith(this.namePrefix)) continue;
        const v = d[this.property];
        if (v && d.Name) byUser.set(String(v).trim().toLowerCase(), d.Name);
      }
      this.cache = { at: Date.now(), byUser };
    } catch (e) {
      log('destination list refresh failed:', (e as Error).message);
      if (!this.cache) this.cache = { at: Date.now(), byUser: new Map() };
    }
  }
}
