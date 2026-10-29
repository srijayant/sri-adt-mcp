export interface Config {
  /** Default BTP destination. */
  destination: string;
  /** Destinations a caller may select via the `destination` tool argument (always includes the default). */
  allowedDestinations: string[];
  /** Explicit map of signed-in user (XSUAA logon name) → their own BTP destination. Takes precedence over the template. */
  userDestinations: Record<string, string>;
  /** Template to derive a per-user destination, e.g. `adt_dest_{user}`. `{user}` is the logon's local part, lowercased. */
  userDestinationTemplate?: string;
  /** If true, a user with no mapped destination is refused instead of falling back to the default. */
  userDestinationRequired: boolean;
  /** Destination additional-property whose value is matched against the signed-in user (e.g. `sri-adt-mcp.user`). Enables property-based discovery when set. */
  userProperty?: string;
  /** Only destinations whose name starts with this prefix are considered for property-based matching (e.g. `adt_mcp_dest`). */
  userDestinationPrefix?: string;
  readOnly: boolean;
  allowedPackages: string[];
  timeoutMs: number;
  maxOutput: number;
  publicUrl?: string;
}

function bool(v: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(v ?? '');
}

function list(v: string | undefined, upper = false): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => (upper ? s.trim().toUpperCase() : s.trim()))
    .filter(Boolean);
}

export function loadConfig(env = process.env): Config {
  const destination = env.SRI_ADT_DESTINATION?.trim();
  if (!destination) throw new Error('SRI_ADT_DESTINATION is required (name of the BTP destination pointing to the ABAP system)');
  const userDestinations = parseMap(env.SRI_ADT_USER_DESTINATIONS);
  return {
    destination,
    allowedDestinations: [...new Set([destination, ...Object.values(userDestinations), ...list(env.SRI_ADT_DESTINATIONS)])],
    userDestinations,
    userDestinationTemplate: env.SRI_ADT_USER_DESTINATION_TEMPLATE?.trim() || undefined,
    userDestinationRequired: bool(env.SRI_ADT_USER_DESTINATION_REQUIRED),
    userProperty: env.SRI_ADT_USER_PROPERTY?.trim() || undefined,
    userDestinationPrefix: env.SRI_ADT_USER_DESTINATION_PREFIX?.trim() || undefined,
    readOnly: bool(env.SRI_ADT_READONLY),
    allowedPackages: list(env.SRI_ADT_ALLOWED_PACKAGES, true),
    timeoutMs: Number(env.SRI_ADT_TIMEOUT_MS ?? 120_000),
    maxOutput: Number(env.SRI_ADT_MAX_OUTPUT ?? 200_000),
    publicUrl: env.SRI_ADT_PUBLIC_URL || undefined,
  };
}

/** Parse a user→destination map from JSON (`{"a@x":"d1"}`) or `a@x=d1,b@x=d2`. Keys are lowercased. */
function parseMap(v: string | undefined): Record<string, string> {
  const s = (v ?? '').trim();
  if (!s) return {};
  const out: Record<string, string> = {};
  if (s.startsWith('{')) {
    try {
      for (const [k, val] of Object.entries(JSON.parse(s) as Record<string, string>)) {
        if (k && val) out[k.trim().toLowerCase()] = String(val).trim();
      }
      return out;
    } catch {
      /* fall through to k=v parsing */
    }
  }
  for (const pair of s.split(',')) {
    const i = pair.indexOf('=');
    if (i > 0) {
      const k = pair.slice(0, i).trim().toLowerCase();
      const val = pair.slice(i + 1).trim();
      if (k && val) out[k] = val;
    }
  }
  return out;
}

/** The destination a signed-in user should use, or undefined if none is configured for them. */
export function resolveUserDestination(cfg: Config, user: string | undefined): string | undefined {
  if (!user) return undefined;
  const mapped = cfg.userDestinations[user.toLowerCase()];
  if (mapped) return mapped;
  if (cfg.userDestinationTemplate) {
    const token = user.split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '_');
    if (token) return cfg.userDestinationTemplate.replace('{user}', token);
  }
  return undefined;
}

export function packageAllowed(cfg: Config, pkg: string | undefined): boolean {
  if (!cfg.allowedPackages.length || !pkg) return true;
  const p = pkg.toUpperCase();
  return cfg.allowedPackages.some((pat) => (pat.endsWith('*') ? p.startsWith(pat.slice(0, -1)) : p === pat));
}
