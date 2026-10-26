#!/usr/bin/env node
import { loadConfig } from './config.js';
import { startHttp } from './httpServer.js';

startHttp(loadConfig()).catch((e) => {
  console.error('[sri-adt] fatal:', e instanceof Error ? e.message : e);
  process.exit(1);
});
