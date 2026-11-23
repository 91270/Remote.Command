// Adapted from dist/tools/edit.js, performSearchReplace (Desktop Commander 0.3.3).
// Retains exact match semantics and line ending handling. No fuzzy fallback,
// editor UI, document adapters, telemetry or plaintext logs.
import { detectLineEnding, normalizeLineEndings } from '../utils/lineEndingHandler.js';
export function exactReplacement(content, block) {
    const fileLineEnding = detectLineEnding(content);
    const normalizedSearch = normalizeLineEndings(block.search, fileLineEnding);
    if (!normalizedSearch) throw new Error('An exact search string is required.');
    const searchIndex = content.indexOf(normalizedSearch);
    if (searchIndex === -1 || content.indexOf(normalizedSearch, searchIndex + normalizedSearch.length) !== -1) {
        throw new Error('The text to edit must occur exactly once.');
    }
    return content.substring(0, searchIndex) +
        normalizeLineEndings(block.replace, fileLineEnding) +
        content.substring(searchIndex + normalizedSearch.length);
}
