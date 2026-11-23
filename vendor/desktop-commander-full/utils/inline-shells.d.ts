import { type ShellType } from './shell.js';
import { type CmdDelayedExpansion, type FoundCommand } from './command-reading.js';
/**
 * What a shell started by a command runs, by the shell's own rules for its
 * arguments: a command text (bash -c 'sudo ls', pwsh -Command 'net user',
 * powershell -EncodedCommand <base64>, cmd /c net user), a script file
 * (bash deploy.sh, pwsh -File deploy.ps1), or its input (bash -s). The
 * shell around it sees a command text only as an argument, so
 * checkCommand() checks the text like any command, read for the shell that
 * runs it. A script file's commands aren't in the text, so the check notes it.
 * eval and Invoke-Expression run a command text too, in the same shell
 * (eval 'sudo ls', Invoke-Expression 'net user'), and their texts follow the
 * same rules: see sameShellTexts(). So do the programs that run one command
 * text in a shell (su -c 'sudo ls', watch 'sudo ls': see TEXT_PROGRAMS in
 * command-wrappers.ts).
 *
 * The rules are which option gives the command text or the file, and which
 * options take a value. They work on the words a reader found, so they read
 * no shell grammar of their own. A POSIX shell's options are read by the
 * wrappers' reader, from its rules there (see command-wrappers.ts), in every
 * way they can be read. A word known only at run time is used as its
 * text ("cd $HOME && sudo ls"), so the programs written in it are still seen.
 * The shell that starts the shell fills that word in before the started shell
 * reads it, so it may hold any command (pwsh -Command $cmd, bash -c "ls $X"):
 * such a command text notes the shell too (file null), as a script file named
 * only at run time does.
 */
/** What a shell runs, or eval or Invoke-Expression in the shell they are in */
export interface ShellRun {
    /** The command texts it is given, each to be read by the shell that runs it */
    texts: string[];
    /**
     * The script file it is given, undefined when it is given none; null when the file, or a part of a command
     * text it is given, is known only at run time, or when its options can be read as naming different files
     */
    file?: string | null;
    /** The shell that reads its texts, when it isn't the program itself: sh for su -c's, cmd for runas's command line */
    shell?: string;
    /** A new CMD invocation's explicit mode; absent/unknown never inherits the outer CMD mode. */
    cmdDelayedExpansion?: CmdDelayedExpansion;
}
/**
 * What eval (in a POSIX shell) or Invoke-Expression (in PowerShell, also
 * written iex) runs in the shell it is in: its command texts. eval joins its
 * words with spaces. Invoke-Expression runs one text, its Command; PowerShell
 * binds one of the words that aren't parameter names to it, and the others
 * may be values of other parameters (iex -ea 0 'net user'), so each of them
 * is a text. Written with a colon, the parameter and its value are one word
 * (iex -Command:'net user'), which runs what iex given that value runs. A
 * text with a part known only at run time is read as written,
 * as the text of bash -c is, so the programs written in it are checked
 * (eval "cd $HOME && sudo ls"). That part may hold any command, so file is
 * null then, and the command is noted; so is a text that comes from the
 * pipeline ('net user' | iex). gsudo, in any shell, runs its command in the
 * shell it was started from too (gsudo 'net user'), and gsudo !! runs the
 * last command again, which the check can't see, so it is noted. No texts
 * for any other command.
 */
export declare function sameShellTexts(found: FoundCommand, shellType: ShellType): ShellRun;
/**
 * What the shell `found` starts runs, or the program that runs one command
 * text in a shell (su -c 'sudo ls'): nothing for any other command. Its kind
 * of shell is taken from its name as found, as checkCommand() takes the
 * reader for a text from the shell it is given.
 * Existing callers may omit context, so preserve their historical program-name readings.
 */
export declare function shellRuns(found: FoundCommand, callerShellType?: ShellType): ShellRun;
