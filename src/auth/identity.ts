export class IdentityError extends Error {}

export interface UserInfo {
  user: string;
  grantType?: string;
}

/** MCP access always requires a signed-in user; technical client_credentials tokens are rejected. */
export function requireUser(sc: { getGrantType?: () => string; getLogonName?: () => string }): UserInfo {
  const grantType = safe(() => sc.getGrantType?.());
  if (grantType === 'client_credentials') {
    throw new IdentityError('Technical (client_credentials) tokens are not accepted: sign in as a user.');
  }
  const user = safe(() => sc.getLogonName?.());
  if (!user) throw new IdentityError('Token carries no user identity: sign in as a user.');
  return { user, grantType };
}

function safe<T>(f: () => T): T | undefined {
  try {
    return f();
  } catch {
    return undefined;
  }
}
