import { z } from 'zod';
import { TYPE_NAMES } from '../adt/uri.js';

export const objectArgs = {
  type: z
    .string()
    .optional()
    .describe(`Object type: ${[...TYPE_NAMES, 'FUNC', 'FUGR_INCL'].join(', ')}`),
  name: z.string().optional().describe('Object name, e.g. ZCL_FOO'),
  group: z.string().optional().describe('Function group (for FUNC / FUGR_INCL)'),
  uri: z.string().optional().describe('Explicit ADT URI (overrides type/name)'),
};
