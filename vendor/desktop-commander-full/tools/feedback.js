import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
// The original feedback tool is retained as a local feedback event.
export async function giveFeedbackToDesktopCommander(params = {}) {
  await appendFile(join(process.env.RCM_CORE_STATE, 'feedback.jsonl'),
    JSON.stringify({ at: new Date().toISOString(), ...params }) + '\n', { mode: 0o600 });
  return { content: [{ type: 'text', text: 'Feedback recorded in the private Agent state directory.' }] };
}
