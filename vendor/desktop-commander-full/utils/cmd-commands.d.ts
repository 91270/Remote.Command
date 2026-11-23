import type { CommandReadOptions, CommandReading } from './command-reading.js';
/** Reads a command for cmd */
export declare function readCmdCommands(command: string, { cmdDelayedExpansion }?: CommandReadOptions): Promise<CommandReading>;
