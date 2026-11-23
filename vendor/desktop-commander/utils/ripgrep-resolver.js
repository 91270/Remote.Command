// No downloaded binary, PATH lookup or workspace executable discovery.
import { isAbsolute } from 'node:path';
export async function getRipgrepPath() {
    const executable = process.env.PRM_RIPGREP;
    if (!executable || !isAbsolute(executable)) throw new Error('Set ripgrep to an absolute executable path in the Agent config.');
    return executable;
}
