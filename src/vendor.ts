// The pinned MIT modules are emitted upstream JavaScript. Only these adapters
// expose their APIs to the local MCP server and process supervisor.
import type { ChildProcess } from 'node:child_process';
const load = (file: string) => import(new URL('../vendor/desktop-commander/' + file, import.meta.url).href);
export const textCore = async () => (await load('utils/files/text.js')) as {
  TextFileHandler: new() => { read(path: string, options: { offset: number; length: number; signal: AbortSignal }): Promise<{ content: string }> }
};
export const editCore = async () => (await load('tools/exact-edit.js')) as {
  exactReplacement(content: string, block: { search: string; replace: string }): string
};
export const renameCore = async () => (await load('utils/rename.js')) as {
  renameWithRetry(from: string, to: string): Promise<void>
};
export const terminateCore = async () => (await load('utils/process-tree.js')) as {
  terminateProcessTree(proc: ChildProcess): Promise<boolean>
};
type Match = { file: string; line?: number; text?: string; type?: string };
export const searchCore = async () => (await load('search-manager.js')) as {
  searchManager: {
    startSearch(options: { rootPath: string; pattern: string; searchType: 'files' | 'content'; maxResults: number; timeout: number; literalSearch: boolean; includeHidden: boolean }): Promise<{ sessionId: string }>;
    waitForCompletion(id: string): Promise<Match[]>;
    readSearchResults(id: string, offset: number, length: number): { results: Match[]; outcome?: string; failure?: string };
    terminateSearch(id: string): boolean;
    forget(id: string): void;
  }
};
