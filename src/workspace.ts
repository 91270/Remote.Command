import { relative, isAbsolute, sep } from 'node:path';

export const inside = (root: string, target: string) => {
  const r = relative(root, target);
  return r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r);
};
export function programEnv(): NodeJS.ProcessEnv {
  // Do not pass OAuth, enrollment, agent credentials, or service launch env.
  const safe = ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG', 'TEMP', 'TMP', 'TMPDIR'];
  return Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && safe.some(n => n.toUpperCase() === k.toUpperCase())));
}
