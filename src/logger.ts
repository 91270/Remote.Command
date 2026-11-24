import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export type LoggerOptions = {
  dir: string;
  maxBytes?: number;
  maxFiles?: number;
};

const logFilePattern = /^\d{8}-\d{4}\.log$/;

function formatMinuteStamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

/**
 * 按文件大小分段存储的日志记录器。
 * 所有日志文件均采用 YYYYMMDD-HHmm.log 格式命名。
 */
export class RotatingLogger {
  private readonly dir: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private currentFile: string | null = null;

  constructor(options: LoggerOptions) {
    this.dir = options.dir;
    this.maxBytes = Math.max(1024, options.maxBytes ?? 10 * 1024 * 1024);
    this.maxFiles = Math.max(1, options.maxFiles ?? 5);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  private fileSize(path: string): number {
    try {
      return statSync(path).size;
    } catch {
      return -1;
    }
  }

  private listLogFiles(): string[] {
    return readdirSync(this.dir)
      .filter(name => logFilePattern.test(name))
      .sort();
  }

  private pruneOldFiles(): void {
    const files = this.listLogFiles();
    while (files.length > this.maxFiles) {
      const oldest = files.shift()!;
      const full = join(this.dir, oldest);
      if (full === this.currentFile) continue;
      try { unlinkSync(full); } catch { /* ignore */ }
    }
  }

  private pickNextFile(incomingBytes: number): string {
    const nowMs = Date.now();
    for (let offset = 0; offset < 10000; offset++) {
      const candidateName = `${formatMinuteStamp(new Date(nowMs + offset * 60_000))}.log`;
      const candidatePath = join(this.dir, candidateName);
      const size = this.fileSize(candidatePath);
      if (size === -1 || size === 0 || size + incomingBytes <= this.maxBytes) {
        return candidatePath;
      }
    }
    return join(this.dir, `${formatMinuteStamp(new Date(nowMs))}.log`);
  }

  private resolveTargetFile(incomingBytes: number): string {
    if (this.currentFile) {
      const size = this.fileSize(this.currentFile);
      if (size >= 0 && (size === 0 || size + incomingBytes <= this.maxBytes)) {
        return this.currentFile;
      }
    } else {
      const existing = this.listLogFiles();
      const latest = existing.at(-1);
      if (latest) {
        const latestPath = join(this.dir, latest);
        const size = this.fileSize(latestPath);
        if (size >= 0 && (size === 0 || size + incomingBytes <= this.maxBytes)) {
          this.currentFile = latestPath;
          return latestPath;
        }
      }
    }
    this.currentFile = this.pickNextFile(incomingBytes);
    return this.currentFile;
  }

  write(level: 'INFO' | 'WARN' | 'ERROR', message: string, mirrorConsole = false): void {
    const line = `[${new Date().toISOString()}] [${level}] ${message}\n`;
    const incomingBytes = Buffer.byteLength(line, 'utf8');
    const target = this.resolveTargetFile(incomingBytes);
    appendFileSync(target, line, { encoding: 'utf8', mode: 0o600 });
    this.pruneOldFiles();
    if (mirrorConsole) {
      if (level === 'ERROR') console.error(message);
      else console.log(message);
    }
  }

  info(message: string, mirrorConsole = false): void {
    this.write('INFO', message, mirrorConsole);
  }

  error(message: string, mirrorConsole = false): void {
    this.write('ERROR', message, mirrorConsole);
  }
}
