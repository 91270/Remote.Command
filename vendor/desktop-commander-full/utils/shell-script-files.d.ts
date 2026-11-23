import { type ArgumentInspection } from './command-reading.js';
type FileWord = string | null;
interface FileWordSource extends ArgumentInspection {
    written?: readonly string[];
}
/** File arguments are found before command/script arguments can be mistaken for more host options. */
export declare function shellScriptFiles(program: string, args: FileWord[], source?: FileWordSource): FileWord[];
export {};
