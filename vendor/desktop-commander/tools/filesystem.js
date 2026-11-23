// Independent adapter for SearchManager. The caller validates relative paths
// before dispatch; recheck the canonical path immediately before spawning rg.
import { relative, isAbsolute, sep } from 'node:path';
import { realpath } from 'node:fs/promises';
export async function validatePath(p) {
    const canonical = await realpath(p);
    const suffix = relative(await realpath(process.cwd()), canonical);
    if (suffix === '..' || suffix.startsWith('..' + sep) || isAbsolute(suffix) || relative(p, canonical) !== '') {
        throw new Error('Search path escapes the workspace or traverses a link.');
    }
    return canonical;
}
