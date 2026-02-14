import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createAgentPlugin,
  type AgentFetchContext,
  type PluginContext,
  type SessionParseOptions,
  type SessionUsageData,
} from '@tokentop/plugin-sdk';

// TODO: Implement session parsing for Gemini CLI
// See @tokentop/agent-opencode for a complete reference implementation.

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
    configPath: path.join(os.homedir(), '.gemini'),
    sessionPath: path.join(os.homedir(), '.gemini'),
  },

  capabilities: {
    sessionParsing: false,
    authReading: false,
    realTimeTracking: false,
    multiProvider: false,
  },

  async isInstalled(_ctx: PluginContext): Promise<boolean> {
    return fs.existsSync(path.join(os.homedir(), '.gemini'));
  },

  async parseSessions(_options: SessionParseOptions, _ctx: AgentFetchContext): Promise<SessionUsageData[]> {
    return [];
  },
});

export default geminiCliAgentPlugin;
