import { isAbsolute } from 'node:path';
import { access } from 'node:fs/promises';
export async function getRipgrepPath() {
  const file = process.env.RCM_RIPGREP;
  if (!file || !isAbsolute(file)) throw new Error('Configure the absolute path of a trusted ripgrep executable on the Agent.');
  await access(file);
  return file;
}
export function clearRipgrepCache() {}
