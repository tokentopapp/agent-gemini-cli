import type { SessionUsageData } from '@tokentop/plugin-sdk';

export interface GeminiCliTokensSummary {
  input: number;       // promptTokenCount
  output: number;      // candidatesTokenCount
  cached: number;      // cachedContentTokenCount
  thoughts?: number;   // thoughtsTokenCount
  tool?: number;       // toolUsePromptTokenCount
  total: number;       // totalTokenCount
}

export type GeminiCliPartList = string | Array<{ text?: string; [key: string]: unknown }>;

export interface GeminiCliBaseMessage {
  id: string;
  timestamp: string;
  content: GeminiCliPartList;
  displayContent?: GeminiCliPartList;
}

export interface GeminiCliGeminiMessage extends GeminiCliBaseMessage {
  type: 'gemini';
  model?: string;
  tokens?: GeminiCliTokensSummary | null;
  toolCalls?: unknown[];
  thoughts?: Array<{ subject: string; description: string; timestamp: string }>;
}

export interface GeminiCliTokenBearingMessage extends GeminiCliBaseMessage {
  type: 'gemini';
  id: string;
  model?: string;
  tokens: GeminiCliTokensSummary;
  toolCalls?: unknown[];
  thoughts?: Array<{ subject: string; description: string; timestamp: string }>;
}

export interface GeminiCliOtherMessage extends GeminiCliBaseMessage {
  type: 'user' | 'info' | 'error' | 'warning';
}

export type GeminiCliMessage = GeminiCliGeminiMessage | GeminiCliOtherMessage;

export interface GeminiCliConversationRecord {
  sessionId: string;
  projectHash: string;
  startTime: string;
  lastUpdated: string;
  messages: GeminiCliMessage[];
  summary?: string;
  directories?: string[];
}

export interface SessionAggregateCacheEntry {
  updatedAt: number;
  usageRows: SessionUsageData[];
  lastAccessed: number;
}
