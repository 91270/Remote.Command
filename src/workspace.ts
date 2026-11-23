import { lstat, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute, sep } from 'node:path';
import type { Stats } from 'node:fs';

export const inside = (root: string, target: string) => {
  const r = relative(root, target);
  return r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r);
};
const reserved = /^(?:CON|CONIN\$|CONOUT\$|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])(?:\.|$)/i;
export async function workspacePath(root: string, input: string, opt: { missing?: boolean; root?: boolean } = {}) {
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || relative(root, await realpath(root)) !== '') throw new Error('Workspace is unavailable or has changed.');
  if (input === '.' && opt.root) return { path: root, info: rootStat };
  const parts = input.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[\\:\u0000-\u001f\u007f<>|?"*]/.test(part) ||
      /[. ]$/.test(part) || reserved.test(part))) throw new Error('Path must be workspace-relative without links, parent segments, or Windows special names.');
  let path = root, info: Stats | undefined;
  for (const [i, part] of parts.entries()) {
    path = join(path, part);
    try { info = await lstat(path); }
    catch (e) {
      if (i === parts.length - 1 && opt.missing && (e as NodeJS.ErrnoException).code === 'ENOENT') return { path };
      throw e;
    }
    if (info.isSymbolicLink() || info.dev !== rootStat.dev || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1)) ||
        (i < parts.length - 1 && !info.isDirectory()) || !inside(root, await realpath(path))) {
      throw new Error('Links, other filesystems and special files cannot be accessed.');
    }
  }
  return { path, info };
}

export function programEnv(): NodeJS.ProcessEnv {
  // Do not pass OAuth, enrollment, agent credentials, or service launch env.
  const safe = ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG', 'TEMP', 'TMP', 'TMPDIR'];
  return Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && safe.some(n => n.toUpperCase() === k.toUpperCase())));
}
