import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

export const GEMINI_CLI_HOME = path.join(os.homedir(), '.gemini');
export const GEMINI_CLI_TMP_PATH = path.join(GEMINI_CLI_HOME, 'tmp');

export async function getChatsDirs(): Promise<string[]> {
  try {
    const hashDirs = await fs.readdir(GEMINI_CLI_TMP_PATH, { withFileTypes: true });
    const chatsDirs: string[] = [];

    for (const entry of hashDirs) {
      if (!entry.isDirectory()) continue;

      const chatsPath = path.join(GEMINI_CLI_TMP_PATH, entry.name, 'chats');
      try {
        await fs.access(chatsPath);
        chatsDirs.push(chatsPath);
      } catch {
      }
    }

    return chatsDirs;
  } catch {
    return [];
  }
}
