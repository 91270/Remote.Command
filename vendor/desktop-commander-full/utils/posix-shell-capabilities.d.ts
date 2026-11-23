import type { BraceSemantics } from './brace-expansion.js';
/**
 * Fixed --version only, on a matching precaptured native endpoint; never caller code or a profile.
 * Native Bash5.2 retains the backslash slot that Bash5.3 omits; other Bash4/5 calls keep legacy rules.
 * Bash3.2 and Zsh5.9 defaults remain supported; startup options and profiles are not evaluated.
 * One bounded query per endpoint (at most 32); unknown, unavailable or other versions retain legacy behavior.
 */
export declare function posixBraceSemantics(shell: string): Promise<BraceSemantics | undefined>;
