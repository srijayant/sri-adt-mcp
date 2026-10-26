import { z, type ZodRawShape } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AdtError, type AdtClient, type AdtResponse } from '../http/adtClient.js';
import { packageAllowed, type Config } from '../config.js';

export interface Ctx {
  client: AdtClient;
  cfg: Config;
}

export interface ToolDef<S extends ZodRawShape> {
  name: string;
  description: string;
  schema: S;
  /** Mutating / executing tools are hidden in read-only mode. */
  write?: boolean;
  handler: (args: z.objectOutputType<S, z.ZodTypeAny>, ctx: Ctx) => Promise<unknown>;
}

export function tool<S extends ZodRawShape>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

/** Shared optional destination arg (maps to X-ADT-Destination). */
export const destinationArg = {
  destination: z
    .string()
    .optional()
    .describe('BTP destination to target; must be listed in SRI_ADT_DESTINATIONS. Omit for the default.'),
};

export function assertPackage(ctx: Ctx, pkg: string | undefined): void {
  if (!packageAllowed(ctx.cfg, pkg)) {
    throw new Error(`Package ${pkg} is not in SRI_ADT_ALLOWED_PACKAGES (${ctx.cfg.allowedPackages.join(', ')})`);
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n\n…[truncated ${s.length - max} chars; narrow the request]` : s;
}

function render(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object' && 'status' in result && 'body' in result && 'headers' in result) {
    const r = result as AdtResponse;
    return `HTTP ${r.status}\ncontent-type: ${r.headers['content-type'] ?? ''}\n\n${r.body}`;
  }
  return JSON.stringify(result, null, 2);
}

export function registerAll(server: McpServer, ctx: Ctx, defs: ToolDef<any>[]): number {
  let n = 0;
  for (const d of defs) {
    if (d.write && ctx.cfg.readOnly) continue;
    server.tool(d.name, d.description, d.schema, async (args: any) => {
      try {
        const out = await d.handler(args, ctx);
        return { content: [{ type: 'text' as const, text: truncate(render(out), ctx.cfg.maxOutput) }] };
      } catch (e) {
        const err = e as Error;
        let text = err.message;
        const cause = (err as { cause?: { code?: string; message?: string } }).cause;
        if (cause) text += ` (${cause.code ?? ''} ${cause.message ?? ''}) — check the destination and Cloud Connector`.replace(/\s+/g, ' ');
        if (e instanceof AdtError) {
          if (e.status === 404) text += '\n(Object or endpoint not found — it may not exist, or this ADT feature is not available on the backend release.)';
          if (e.status === 400 && /destination not allowed/.test(e.body)) text += '\n(Destination not in SRI_ADT_DESTINATIONS.)';
          if (e.status === 403) text += '\n(Backend refused: the ABAP user in the destination may lack authorization, or the CSRF/session expired.)';
        }
        return { isError: true, content: [{ type: 'text' as const, text: truncate(text, ctx.cfg.maxOutput) }] };
      }
    });
    n++;
  }
  return n;
}
