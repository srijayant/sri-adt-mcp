export interface Config {
  /** Default BTP destination. */
  destination: string;
  /** Destinations a caller may select via the `destination` tool argument (always includes the default). */
  allowedDestinations: string[];
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
  return {
    destination,
    allowedDestinations: [...new Set([destination, ...list(env.SRI_ADT_DESTINATIONS)])],
    readOnly: bool(env.SRI_ADT_READONLY),
    allowedPackages: list(env.SRI_ADT_ALLOWED_PACKAGES, true),
    timeoutMs: Number(env.SRI_ADT_TIMEOUT_MS ?? 120_000),
    maxOutput: Number(env.SRI_ADT_MAX_OUTPUT ?? 200_000),
    publicUrl: env.SRI_ADT_PUBLIC_URL || undefined,
  };
}

export function packageAllowed(cfg: Config, pkg: string | undefined): boolean {
  if (!cfg.allowedPackages.length || !pkg) return true;
  const p = pkg.toUpperCase();
  return cfg.allowedPackages.some((pat) => (pat.endsWith('*') ? p.startsWith(pat.slice(0, -1)) : p === pat));
}
