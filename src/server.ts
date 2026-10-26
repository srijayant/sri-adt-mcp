import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAll, type Ctx, type ToolDef } from './tools/registry.js';
import { coreTools } from './tools/core.js';
import { navigateTools } from './tools/navigate.js';
import { sourceTools } from './tools/source.js';
import { checkTools } from './tools/checks.js';
import { createTools } from './tools/create.js';
import { qualityTools } from './tools/quality.js';
import { transportTools } from './tools/transports.js';
import { runtimeTools } from './tools/runtime.js';
import { debuggerTools } from './tools/debugger.js';
import { serviceTools } from './tools/services.js';
import { abapgitTools } from './tools/abapgit.js';

export const VERSION = '1.1.0';

export const ALL_TOOLS: ToolDef<any>[] = [
  ...coreTools,
  ...navigateTools,
  ...sourceTools,
  ...checkTools,
  ...createTools,
  ...qualityTools,
  ...transportTools,
  ...runtimeTools,
  ...debuggerTools,
  ...serviceTools,
  ...abapgitTools,
];

export function buildServer(ctx: Ctx): { server: McpServer; toolCount: number } {
  const server = new McpServer({ name: 'sri-adt-mcp', version: VERSION });
  const toolCount = registerAll(server, ctx, ALL_TOOLS);
  return { server, toolCount };
}
