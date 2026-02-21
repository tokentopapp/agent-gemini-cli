import * as fs from 'fs/promises';

export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

export function extractProjectPath(directories: string[] | undefined): string | undefined {
  if (!directories || directories.length === 0) return undefined;
  const first = directories[0]?.trim();
  return first && first.length > 0 ? first : undefined;
}
