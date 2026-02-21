import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import type { ActivityCallback, ActivityUpdate } from '@tokentop/plugin-sdk';
import { GEMINI_CLI_TMP_PATH, getChatsDirs } from './paths.ts';
import type { GeminiCliConversationRecord } from './types.ts';
import { isTokenBearingGeminiMessage, toTimestamp } from './parser.ts';
import { readJsonFile } from './utils.ts';

export interface SessionWatcherState {
  chatsDirWatchers: Map<string, fsSync.FSWatcher>;
  rootWatcher: fsSync.FSWatcher | null;
  dirtyPaths: Set<string>;
  reconciliationTimer: ReturnType<typeof setInterval> | null;
  started: boolean;
}

interface ActivityWatcherState {
  chatsDirWatchers: Map<string, fsSync.FSWatcher>;
  rootWatcher: fsSync.FSWatcher | null;
  callback: ActivityCallback | null;
  seenMessageIds: Map<string, Set<string>>;
  started: boolean;
}

export const RECONCILIATION_INTERVAL_MS = 10 * 60 * 1000;

export const sessionWatcher: SessionWatcherState = {
  chatsDirWatchers: new Map(),
  rootWatcher: null,
  dirtyPaths: new Set(),
  reconciliationTimer: null,
  started: false,
};

const activityWatcher: ActivityWatcherState = {
  chatsDirWatchers: new Map(),
  rootWatcher: null,
  callback: null,
  seenMessageIds: new Map(),
  started: false,
};

export let forceFullReconciliation = false;

function tryWatchNewHashDir(hashDirName: string, watchFn: (chatsDirPath: string) => void): void {
  const chatsPath = path.join(GEMINI_CLI_TMP_PATH, hashDirName, 'chats');
  try {
    if (fsSync.existsSync(chatsPath) && fsSync.statSync(chatsPath).isDirectory()) {
      watchFn(chatsPath);
    }
  } catch {
  }
}

function watchChatsDirForActivity(chatsDirPath: string): void {
  if (activityWatcher.chatsDirWatchers.has(chatsDirPath)) return;

  try {
    const watcher = fsSync.watch(chatsDirPath, (_eventType, filename) => {
      if (!filename || !filename.startsWith('session-') || !filename.endsWith('.json')) return;
      const filePath = path.join(chatsDirPath, filename);
      void processSessionDelta(filePath);
    });

    activityWatcher.chatsDirWatchers.set(chatsDirPath, watcher);
  } catch {
  }
}

async function primeSeenMessages(chatsDirPath: string): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(chatsDirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith('session-') || !entry.name.endsWith('.json')) continue;

    const filePath = path.join(chatsDirPath, entry.name);
    const record = await readJsonFile<GeminiCliConversationRecord>(filePath);
    if (!record) continue;

    const seenIds = new Set<string>();
    for (const msg of record.messages) {
      if (isTokenBearingGeminiMessage(msg)) {
        seenIds.add(msg.id);
      }
    }
    activityWatcher.seenMessageIds.set(filePath, seenIds);
  }
}

async function processSessionDelta(filePath: string): Promise<void> {
  const callback = activityWatcher.callback;
  if (!callback) return;

  const record = await readJsonFile<GeminiCliConversationRecord>(filePath);
  if (!record) return;

  let seenIds = activityWatcher.seenMessageIds.get(filePath);
  if (!seenIds) {
    seenIds = new Set();
    activityWatcher.seenMessageIds.set(filePath, seenIds);
  }

  for (const msg of record.messages) {
    if (!isTokenBearingGeminiMessage(msg)) continue;
    if (seenIds.has(msg.id)) continue;

    seenIds.add(msg.id);

    const tokens: ActivityUpdate['tokens'] = {
      input: msg.tokens.input,
      output: msg.tokens.output,
    };
    if (msg.tokens.cached > 0) {
      tokens.cacheRead = msg.tokens.cached;
    }
    if (msg.tokens.thoughts && msg.tokens.thoughts > 0) {
      tokens.reasoning = msg.tokens.thoughts;
    }

    callback({
      sessionId: record.sessionId,
      messageId: msg.id,
      tokens,
      timestamp: toTimestamp(msg.timestamp, Date.now()),
    });
  }
}

export function watchChatsDir(chatsDirPath: string): void {
  if (sessionWatcher.chatsDirWatchers.has(chatsDirPath)) return;

  try {
    const watcher = fsSync.watch(chatsDirPath, (_eventType, filename) => {
      if (filename?.startsWith('session-') && filename?.endsWith('.json')) {
        const filePath = path.join(chatsDirPath, filename);
        sessionWatcher.dirtyPaths.add(filePath);
      }
    });
    sessionWatcher.chatsDirWatchers.set(chatsDirPath, watcher);
  } catch {
  }
}

export function startSessionWatcher(): void {
  if (sessionWatcher.started) return;
  sessionWatcher.started = true;

  try {
    sessionWatcher.rootWatcher = fsSync.watch(GEMINI_CLI_TMP_PATH, (eventType, filename) => {
      if (eventType !== 'rename' || !filename) return;
      tryWatchNewHashDir(filename, watchChatsDir);
    });
  } catch {
  }

  void getChatsDirs().then((dirs) => {
    for (const dirPath of dirs) {
      watchChatsDir(dirPath);
    }
  });

  sessionWatcher.reconciliationTimer = setInterval(() => {
    forceFullReconciliation = true;
  }, RECONCILIATION_INTERVAL_MS);
}

export function stopSessionWatcher(): void {
  if (sessionWatcher.reconciliationTimer) {
    clearInterval(sessionWatcher.reconciliationTimer);
    sessionWatcher.reconciliationTimer = null;
  }

  for (const watcher of sessionWatcher.chatsDirWatchers.values()) {
    watcher.close();
  }
  sessionWatcher.chatsDirWatchers.clear();

  if (sessionWatcher.rootWatcher) {
    sessionWatcher.rootWatcher.close();
    sessionWatcher.rootWatcher = null;
  }

  sessionWatcher.dirtyPaths.clear();
  sessionWatcher.started = false;
}

export function consumeForceFullReconciliation(): boolean {
  const value = forceFullReconciliation;
  if (forceFullReconciliation) {
    forceFullReconciliation = false;
  }
  return value;
}

export function startActivityWatch(callback: ActivityCallback): void {
  activityWatcher.callback = callback;

  if (activityWatcher.started) return;
  activityWatcher.started = true;

  try {
    activityWatcher.rootWatcher = fsSync.watch(GEMINI_CLI_TMP_PATH, (eventType, filename) => {
      if (eventType !== 'rename' || !filename) return;

      const chatsPath = path.join(GEMINI_CLI_TMP_PATH, filename, 'chats');
      watchChatsDirForActivity(chatsPath);
      void primeSeenMessages(chatsPath);
    });
  } catch {
  }

  void getChatsDirs().then((dirs) => {
    for (const dirPath of dirs) {
      watchChatsDirForActivity(dirPath);
      void primeSeenMessages(dirPath);
    }
  });
}

export function stopActivityWatch(): void {
  for (const watcher of activityWatcher.chatsDirWatchers.values()) {
    watcher.close();
  }
  activityWatcher.chatsDirWatchers.clear();

  if (activityWatcher.rootWatcher) {
    activityWatcher.rootWatcher.close();
    activityWatcher.rootWatcher = null;
  }

  activityWatcher.seenMessageIds.clear();
  activityWatcher.callback = null;
  activityWatcher.started = false;

  stopSessionWatcher();
}
