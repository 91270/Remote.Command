/**
 * Brace expansion, the way bash does it before it runs a command: x{1,2}y
 * becomes the words x1y and x2y, and {1..3} becomes 1 2 3. So {sudo,ls} runs
 * sudo, and su{d..d}o runs sudo too. zsh expands the same forms. The command
 * check's POSIX reader uses it to find the program such a command name runs.
 */
/** One character of a word, and whether it is quoted or escaped there: a quoted "{", "," or "}" is only text */
export interface WordChar {
    char: string;
    quoted: boolean;
}
/** The most words of one expansion the check reads; past that it gives up rather than check part of it */
export declare const MAX_BRACE_WORDS = 1000;
/** Default calls retain the historical reading; native capabilities select one range grammar. */
export type BraceSemantics = 'legacy' | 'bash3' | 'bash5.2' | 'zsh';
export interface BraceOptions {
    semantics?: BraceSemantics;
}
/** Characters that are all text: a quoted part of a word, or a part with no brace syntax in it */
export declare function quotedChars(text: string): WordChar[];
/** Characters as written outside quotes, where a backslash makes the character after it text */
export declare function unquotedChars(text: string): WordChar[];
/**
 * The words bash makes from a word by brace expansion, in bash's order, without
 * the unquoted empty ones: bash drops {,sudo}'s empty word, but keeps {"",sudo}'s.
 * A word without an expansion gives itself. Past MAX_BRACE_WORDS words or
 * MAX_BRACE_STEPS steps it gives null, and the reader takes the command as
 * unreadable.
 */
export declare function braceWords(chars: WordChar[], { semantics }?: BraceOptions): string[] | null;
