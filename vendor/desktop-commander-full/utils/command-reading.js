/**
 * What the command check finds in a command's text. The check reads each
 * command with a reader for the shell that will run it (POSIX shells,
 * PowerShell, cmd). Every reader returns a CommandReading, and checkCommand()
 * in command-manager.ts turns it into a CommandCheck.
 */
/** An input budget failure, handled like unreadable input rather than a server failure. */
export class IncompleteArgumentsError extends Error {
}
/** Consumers call this only after their existing rules say they need the argument vector. */
export function requireCompleteArguments(inspection) {
    if (inspection.argumentError !== undefined)
        throw new IncompleteArgumentsError(inspection.argumentError);
}
