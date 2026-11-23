/**
 * Resolves a shell or other program name ("pwsh", "bash.exe", "where") or path
 * ("/bin/zsh") to an executable file. Bare names are searched in PATH's
 * folders only, never the working folder. Returns null when it can't be found.
 */
export declare function resolveShellPath(shell: string): string | null;
export declare function isShellAvailable(shell: string): boolean;
/**
 * The full path to start a program by: the one found on PATH. Windows looks
 * for a bare name ("powershell.exe", "cmd", "tasklist") in the working folder
 * before PATH, so a file of that name there would run instead; every program
 * Desktop Commander starts by name goes through here. On Windows a bare name
 * not found on PATH is an error rather than a name Windows would look up in
 * the working folder. A path (absolute, or with a folder in it) is kept as
 * given, and so is a bare name elsewhere, where the working folder isn't searched.
 */
export declare function resolveProgramPath(program: string): string;
/**
 * The environment for what Desktop Commander runs for the AI (start_process
 * commands, node:local code): the server's own, with on Windows what a
 * client's launch broke or left out put back. PATHEXT is repaired (#481).
 * ProgramData is set when missing: a client on the MCP SDK's default
 * environment leaves it out, and Windows OpenSSH (ssh, scp, sftp, ssh-keygen)
 * exits 255 without a word when it's unset (#702). Windows keeps it on the
 * system drive, which the SDK's set does pass (SystemDrive, else SystemRoot's
 * drive); with neither it stays unset.
 */
export declare function getCommandEnvironment(): NodeJS.ProcessEnv;
/**
 * The environment of the shell start_process runs a command in: the
 * command environment, with TERM for better terminal compatibility. The
 * PowerShell helper starts with it too, so the user's profile sees the same.
 */
export declare function getShellEnvironment(): NodeJS.ProcessEnv;
/**
 * The shell used when the user hasn't configured one.
 * Windows: Windows PowerShell, falling back to %ComSpec%.
 * macOS/Linux: $SHELL, falling back to the OS default shell.
 */
export declare function getDefaultShell(): string;
/**
 * Shells installed on this machine, default shell first. Only shells that
 * resolve to an executable are returned.
 */
export declare function detectAvailableShells(): string[];
/**
 * A program's name without its folder or extension, lowercased:
 * C:\Windows\System32\NET.EXE is "net". The folder goes as Windows writes it
 * (\ or /, or a drive, as in C:sc.exe). POSIX shells outside Windows use
 * only / as a folder separator. PowerShell also removes .ps1; on Windows
 * and WSL the extensions in the repaired PATHEXT are removed as commands run
 * with them. WSL runs Windows programs from Linux
 * (sc.exe stop Spooler), so there too. The command check compares the names it
 * finds and the blockedCommands entries in this form. POSIX shells on
 * Windows still accept Windows paths, as Git Bash does.
 * Without a shell type, retain the historical PowerShell-style normalization.
 */
export declare function programName(name: string, shellType?: ShellType): string;
/** The kinds of shell a command can run in. The command check has a reader for each. */
export type ShellType = 'posix' | 'powershell' | 'cmd';
/**
 * Which kind of shell a shell program is, by its name without folder and
 * lowercased, as getShellSpawnArgs() reads it: pwsh and powershell (with or
 * without .exe) are PowerShell, cmd and cmd.exe are cmd, and every other shell
 * (bash, zsh, sh, dash, ksh, fish) is POSIX. getShellSpawnArgs() starts each
 * kind its own way.
 */
export declare function getShellType(shell: string): ShellType;
/** The POSIX shells (and fish) by programName(): each runs a script file it's given (bash deploy.sh) */
export declare const POSIX_SHELLS: Set<string>;
/**
 * The shell start_process runs a command in: the one asked for, else the
 * defaultShell setting, else this machine's default. The command check reads
 * the command with the same shell.
 */
export declare function getCommandShell(shell: string | undefined, defaultShell: string | undefined): string;
/**
 * Configuration for spawning a shell with appropriate flags
 */
export interface ShellSpawnConfig {
    executable: string;
    args: string[];
    useShellOption: string | boolean;
    windowsVerbatim?: boolean;
}
/**
 * Get the appropriate spawn configuration for a given shell
 * This handles login shell flags for different shell types
 */
export declare function getShellSpawnArgs(shellPath: string, command: string): ShellSpawnConfig;
