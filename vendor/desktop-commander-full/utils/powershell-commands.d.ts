import type { CommandReading } from './command-reading.js';
/**
 * The command check's reader for PowerShell. No JavaScript parser reads
 * PowerShell correctly (here-strings, @{ } tables, & $var), so a helper
 * PowerShell process reads each command with PowerShell's own parser. It
 * starts at the first PowerShell check, so nothing runs for users who never
 * run PowerShell commands, and it is kept running: a check then takes a few
 * milliseconds instead of PowerShell's start (about a second for Windows
 * PowerShell). It is not a terminal session, so list_sessions never shows it.
 * It starts as the PowerShell a command runs in starts: with the user's
 * profile (start_process starts it without -NoProfile), without
 * -NonInteractive, with -Login for PowerShell 7, and with the commands'
 * environment. So a profile sets the same aliases for both. Only its working
 * folder is its own (see start()).
 */
/** How long a check waits for a running helper's answer. A helper that doesn't answer is stopped, and the check fails. */
export declare const HELPER_TIMEOUT_MS = 5000;
/**
 * How long the first check waits after a helper starts, PowerShell's start
 * and the user's profile included: about a second for Windows PowerShell,
 * longer on a busy machine or with a slow profile
 */
export declare const HELPER_START_TIMEOUT_MS = 15000;
/** One helper process for one PowerShell program, started at its first read and again after it ended */
export declare class PowerShellHelper {
    private readonly program;
    private readonly args;
    private child;
    private output;
    private nextId;
    private readonly pending;
    private timer;
    /** Whether the running helper process has answered yet: until then its start counts in the time limit */
    private answered;
    /** Made at each start and sent with every request; an answer has it, a line the profile printed doesn't */
    private token;
    /** args replace the helper's arguments, for a stand-in in tests */
    constructor(program: string, args?: string[]);
    /** The running helper's process id: undefined before the first read and after the process ended */
    get pid(): number | undefined;
    /** Reads one command. It rejects when the helper doesn't answer in time, can't start, or ends first. */
    read(command: string): Promise<CommandReading>;
    /** The time limit for the oldest waiting request: longer while the helper hasn't answered since it started */
    private startTimeLimit;
    /** Ends the helper process. The next read starts a new one. */
    stop(): void;
    private start;
    private onOutput;
    private onAnswer;
    /** The helper process ended or failed to start: every waiting read fails, and the next read starts a new one */
    private ended;
    private fail;
}
/**
 * Reads a command for a PowerShell shell ("powershell.exe", "pwsh" or a path),
 * only when its filesystem identity matches a launch-PATH parser. Custom
 * executables are refused before startup, rather than used to validate themselves.
 */
export declare function readPowerShellCommands(command: string, shell: string): Promise<CommandReading>;
/** The process ids of the helpers running now, for tests */
export declare function runningPowerShellHelpers(): number[];
