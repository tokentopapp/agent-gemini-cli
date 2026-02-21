import * as fs from 'fs/promises';
import * as path from 'path';
import type { AgentFetchContext, SessionParseOptions, SessionUsageData } from '@tokentop/plugin-sdk';
import { CACHE_TTL_MS, evictSessionAggregateCache, sessionAggregateCache, sessionCache, sessionMetadataIndex } from './cache.ts';
import { GEMINI_CLI_TMP_PATH, getChatsDirs } from './paths.ts';
import type { GeminiCliConversationRecord, GeminiCliTokenBearingMessage } from './types.ts';
import { extractProjectPath, readJsonFile } from './utils.ts';
import {
  consumeForceFullReconciliation,
  sessionWatcher,
  startSessionWatcher,
  watchChatsDir,
} from './watcher.ts';

interface ParsedSessionFile {
  sessionId: string;
  filePath: string;
  mtimeMs: number;
}

export function toTimestamp(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function isTokenBearingGeminiMessage(msg: unknown): msg is GeminiCliTokenBearingMessage {
  if (!msg || typeof msg !== 'object') return false;

  const candidate = msg as Partial<GeminiCliTokenBearingMessage>;
  if (candidate.type !== 'gemini') return false;
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) return false;

  const tokens = candidate.tokens;
  if (!tokens || typeof tokens !== 'object') return false;
  if (typeof tokens.input !== 'number' || tokens.input <= 0) return false;
  if (typeof tokens.output !== 'number') return false;
  if (typeof tokens.cached !== 'number') return false;
  if (typeof tokens.total !== 'number') return false;

  return true;
}

export function parseSessionFileRows(
  record: GeminiCliConversationRecord,
  mtimeMs: number,
): SessionUsageData[] {
  const deduped = new Map<string, SessionUsageData>();
  const projectPath = extractProjectPath(record.directories);
  const sessionName = record.summary?.trim() || undefined;

  for (const msg of record.messages) {
    if (!isTokenBearingGeminiMessage(msg)) continue;

    const usage: SessionUsageData = {
      sessionId: record.sessionId,
      providerId: 'google',
      modelId: msg.model ?? 'unknown',
      tokens: {
        input: msg.tokens.input,
        output: msg.tokens.output,
      },
      timestamp: toTimestamp(msg.timestamp, toTimestamp(record.startTime, mtimeMs)),
      sessionUpdatedAt: mtimeMs,
    };

    if (sessionName) {
      usage.sessionName = sessionName;
    }
    if (msg.tokens.cached > 0) {
      usage.tokens.cacheRead = msg.tokens.cached;
    }
    if (projectPath) {
      usage.projectPath = projectPath;
    }

    deduped.set(msg.id, usage);
  }

  return Array.from(deduped.values());
}

export async function parseSessionsFromProjects(
  options: SessionParseOptions,
  ctx: AgentFetchContext,
): Promise<SessionUsageData[]> {
  const limit = options.limit ?? 100;
  const since = options.since;

  try {
    await fs.access(GEMINI_CLI_TMP_PATH);
  } catch {
    ctx.logger.debug('No Gemini CLI tmp directory found');
    return [];
  }

  startSessionWatcher();

  const now = Date.now();
  if (
    !options.sessionId &&
    limit === sessionCache.lastLimit &&
    now - sessionCache.lastCheck < CACHE_TTL_MS &&
    sessionCache.lastResult.length > 0 &&
    sessionCache.lastSince === since
  ) {
    ctx.logger.debug('Gemini CLI: using cached sessions (within TTL)', { count: sessionCache.lastResult.length });
    return sessionCache.lastResult;
  }

  const dirtyPaths = new Set(sessionWatcher.dirtyPaths);
  sessionWatcher.dirtyPaths.clear();

  const needsFullStat = consumeForceFullReconciliation();
  if (needsFullStat) {
    ctx.logger.debug('Gemini CLI: full reconciliation sweep triggered');
  }

  const sessionFiles: ParsedSessionFile[] = [];
  const seenFilePaths = new Set<string>();

  let statCount = 0;
  let statSkipCount = 0;
  let dirtyHitCount = 0;

  const chatsDirs = await getChatsDirs();

  for (const chatsDirPath of chatsDirs) {
    watchChatsDir(chatsDirPath);

    let entries;
    try {
      entries = await fs.readdir(chatsDirPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith('session-') || !entry.name.endsWith('.json')) continue;

      const filePath = path.join(chatsDirPath, entry.name);
      seenFilePaths.add(filePath);

      const isDirty = dirtyPaths.has(filePath);
      if (isDirty) dirtyHitCount++;

      const metadata = sessionMetadataIndex.get(filePath);

      if (options.sessionId && metadata && metadata.sessionId !== options.sessionId) continue;

      if (!isDirty && !needsFullStat && metadata) {
        statSkipCount++;

        if (!since || metadata.mtimeMs >= since) {
          sessionFiles.push({
            sessionId: metadata.sessionId,
            filePath,
            mtimeMs: metadata.mtimeMs,
          });
        }
        continue;
      }

      statCount++;
      let mtimeMs: number;
      try {
        const stat = await fs.stat(filePath);
        mtimeMs = stat.mtimeMs;
      } catch {
        sessionMetadataIndex.delete(filePath);
        continue;
      }

      if (metadata && metadata.mtimeMs === mtimeMs) {
        if (options.sessionId && metadata.sessionId !== options.sessionId) continue;

        if (!since || metadata.mtimeMs >= since) {
          sessionFiles.push({
            sessionId: metadata.sessionId,
            filePath,
            mtimeMs: metadata.mtimeMs,
          });
        }
        continue;
      }

      const record = await readJsonFile<GeminiCliConversationRecord>(filePath);
      if (!record || !record.sessionId) {
        sessionMetadataIndex.delete(filePath);
        continue;
      }

      sessionMetadataIndex.set(filePath, { mtimeMs, sessionId: record.sessionId });

      if (options.sessionId && record.sessionId !== options.sessionId) continue;

      if (!since || mtimeMs >= since) {
        sessionFiles.push({ sessionId: record.sessionId, filePath, mtimeMs });
      }
    }
  }

  for (const cachedPath of sessionMetadataIndex.keys()) {
    if (!seenFilePaths.has(cachedPath)) {
      sessionMetadataIndex.delete(cachedPath);
    }
  }

  sessionFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const sessions: SessionUsageData[] = [];
  let aggregateCacheHits = 0;
  let aggregateCacheMisses = 0;

  for (const file of sessionFiles) {
    const cached = sessionAggregateCache.get(file.sessionId);
    if (cached && cached.updatedAt === file.mtimeMs) {
      cached.lastAccessed = now;
      aggregateCacheHits++;
      sessions.push(...cached.usageRows);
      continue;
    }

    aggregateCacheMisses++;

    const record = await readJsonFile<GeminiCliConversationRecord>(file.filePath);
    if (!record) continue;

    const usageRows = parseSessionFileRows(record, file.mtimeMs);

    sessionAggregateCache.set(file.sessionId, {
      updatedAt: file.mtimeMs,
      usageRows,
      lastAccessed: now,
    });

    sessions.push(...usageRows);
  }

  evictSessionAggregateCache();

  if (!options.sessionId) {
    sessionCache.lastCheck = Date.now();
    sessionCache.lastResult = sessions;
    sessionCache.lastLimit = limit;
    sessionCache.lastSince = since;
  }

  ctx.logger.debug('Gemini CLI: parsed sessions', {
    count: sessions.length,
    sessionFiles: sessionFiles.length,
    statChecks: statCount,
    statSkips: statSkipCount,
    dirtyHits: dirtyHitCount,
    aggregateCacheHits,
    aggregateCacheMisses,
    metadataIndexSize: sessionMetadataIndex.size,
    aggregateCacheSize: sessionAggregateCache.size,
  });

  return sessions;
}
