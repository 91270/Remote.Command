import type { CommandReading } from './command-reading.js';
/**
 * The caller supplies its actual selected native endpoint; no endpoint or unsupported capability
 * retains the legacy reading exactly. Capability capture happens on import, not after caller changes.
 */
export declare function readPosixCommands(command: string, selectedShell?: string): Promise<CommandReading>;
