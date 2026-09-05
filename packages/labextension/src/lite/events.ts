import { PathExt } from '@jupyterlab/coreutils';
import { Contents } from '@jupyterlab/services';

import { readIfExists, writeTextFile } from '../actions/contents';
import { WORKSHOP_STATE_DIR } from '../state';
import { IEventsBatch } from '../tokens';

/** File under the state directory the events are appended to. */
const EVENTS_FILE = 'events.jsonl';

/** Most events one post to a sink carries. */
const MAX_BATCH = 500;

/**
 * Append a batch of events to the workshop's events file and, when the
 * batch names a sink, post them to it straight from the browser as JSON
 * lines. The sink has to allow cross-origin requests from the site.
 */
export async function recordEvents(
  contents: Contents.IManager,
  batch: IEventsBatch
): Promise<void> {
  const lines = batch.events.map(event => JSON.stringify(event));
  const path = PathExt.join(batch.workshop, WORKSHOP_STATE_DIR, EVENTS_FILE);
  const existing = (await readIfExists(contents, path)) ?? '';

  await writeTextFile(contents, path, `${existing}${lines.join('\n')}\n`);

  if (!batch.sink) {
    return;
  }

  try {
    await fetch(batch.sink, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-ndjson' },
      body: `${lines.slice(0, MAX_BATCH).join('\n')}\n`,
      keepalive: true
    });
  } catch (error) {
    console.warn(`Unable to forward workshop events to ${batch.sink}`, error);
  }
}
