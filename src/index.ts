import * as fs from 'fs';
import {
  createAgentPlugin,
  type AgentFetchContext,
  type PluginContext,
  type SessionParseOptions,
  type SessionUsageData,
} from '@tokentop/plugin-sdk';
import { CACHE_TTL_MS, SESSION_AGGREGATE_CACHE_MAX, sessionAggregateCache, sessionCache, sessionMetadataIndex } from './cache.ts';
import { parseSessionsFromProjects } from './parser.ts';
import { GEMINI_CLI_HOME, GEMINI_CLI_TMP_PATH } from './paths.ts';
import { RECONCILIATION_INTERVAL_MS, startActivityWatch, stopActivityWatch } from './watcher.ts';

const geminiCliAgentPlugin = createAgentPlugin({
  id: 'gemini-cli',
  type: 'agent',
  name: 'Gemini CLI',
  version: '0.1.0',

  meta: {
    description: 'Gemini CLI session tracking',
    homepage: 'https://github.com/google-gemini/gemini-cli',
  },

  permissions: {
    filesystem: {
      read: true,
      paths: ['~/.gemini'],
    },
  },

  agent: {
    name: 'Gemini CLI',
    command: 'gemini',
    configPath: GEMINI_CLI_HOME,
    sessionPath: GEMINI_CLI_TMP_PATH,
  },

  capabilities: {
    sessionParsing: true,
    authReading: false,
    realTimeTracking: true,
    multiProvider: false,
  },

  startActivityWatch(_ctx: PluginContext, callback): void {
    startActivityWatch(callback);
  },

  stopActivityWatch(_ctx: PluginContext): void {
    stopActivityWatch();
  },

  async isInstalled(_ctx: PluginContext): Promise<boolean> {
    return fs.existsSync(GEMINI_CLI_TMP_PATH) || fs.existsSync(GEMINI_CLI_HOME);
  },

  async parseSessions(options: SessionParseOptions, ctx: AgentFetchContext): Promise<SessionUsageData[]> {
    return parseSessionsFromProjects(options, ctx);
  },
});

export {
  CACHE_TTL_MS,
  GEMINI_CLI_HOME,
  GEMINI_CLI_TMP_PATH,
  RECONCILIATION_INTERVAL_MS,
  SESSION_AGGREGATE_CACHE_MAX,
  sessionAggregateCache,
  sessionCache,
  sessionMetadataIndex,
};

export default geminiCliAgentPlugin;
