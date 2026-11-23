import { type ArgumentInspection, type FoundCommand } from './command-reading.js';
/**
 * The commands that run in `shell`: each of `commands`, followed by the
 * programs that the wrappers among them start (for env sudo ls: env, then
 * sudo). A started program has its wrapper's start.
 */
export declare function withStartedPrograms(commands: FoundCommand[], shell: string): FoundCommand[];
/** Where a program's options end, in each way they can be read, and the command texts and programs they give */
export interface OptionReadings {
    /** The first word after the options, in each reading: a wrapper's program, or a shell's script file */
    operands: number[];
    /**
     * Each command text an option gives, or for a shell the first word after its options (bash -c 'sudo ls'), with
     * the first word after it. The text is null when it is known only at run time, in whole or in part; `at` is then
     * the word that holds it. It has no `at` when it is in the option's own word (--command='sudo ls'), and `to`
     * when it is the words from `at` up to that one, joined with spaces (watch -n 5 sudo ls)
     */
    texts: {
        text: string | null;
        at?: number;
        to?: number;
        after: number;
    }[];
    /** Each program an option names (start-stop-daemon --exec), null when known only at run time; `at` is its word, unless it is in the option's own */
    programs: {
        program: string | null;
        at?: number;
    }[];
    /** Whether it also runs command texts that aren't among its words, as parallel's from a :::: file (see commandFiles) */
    hidden: boolean;
}
/** How a POSIX shell, by its name in POSIX_SHELLS, reads its own options (see BASH_OPTIONS) */
export declare function shellOptionReadings(program: string, words: (string | null)[]): OptionReadings;
/**
 * For a program that runs one command text in a shell (see TEXT_PROGRAMS): its
 * options read in every way, and the shell that reads its texts. Undefined for
 * any other program.
 */
export declare function textProgramReadings(program: string, words: (string | null)[], inspection?: ArgumentInspection): {
    readings: OptionReadings;
    shell: string;
    arguments?: number[];
} | undefined;
/** For a program that runs one command text in the shell it was started from (see SAME_SHELL_PROGRAMS): its options read in every way */
export declare function sameShellProgramReadings(program: string, words: (string | null)[], inspection?: ArgumentInspection): OptionReadings | undefined;
