/**
 * Turning a recorded session into draft pages: one action per step with
 * placeholder prose, split into pages at the markers the author inserted
 * while recording.
 */

import { lineDiff } from '../diff';
import { WorkshopFormatError } from '../errors';
import { isRecord } from '../util';
import { serializeDirective } from './directive';
import { newPagePath, setManifestPages } from './manifest';

/** One thing that happened while recording. */
export type RecordedEvent =
  | {
      kind: 'terminal';
      ts: string;

      /** Workshop session name, or the terminal's own name. */
      session: string;
      command: string;

      /** Whether tab completion or history recall made the text unsure. */
      uncertain?: boolean;
    }
  | {
      kind: 'file-saved';
      ts: string;
      path: string;
      content: string;

      /** The content before the save, or null for a new file. */
      previous: string | null;
    }
  | { kind: 'cell-executed'; ts: string; path: string; source: string }
  | { kind: 'file-opened'; ts: string; path: string }
  | { kind: 'page-break'; ts: string; title: string };

/** A saved recording. */
export interface IRecording {
  version: 1;
  started: string;
  events: RecordedEvent[];
}

/** A page written from a recording. */
export interface IDraftPage {
  path: string;
  title: string;
  source: string;
}

/** What a recording turns into. */
export interface IDraftWorkshop {
  pages: IDraftPage[];

  /** Capabilities the drafted actions need, as manifest entries. */
  capabilities: string[];
}

/** Options for drafting. */
export interface IDraftOptions {
  /** Title of the first page, before any marker. */
  firstTitle?: string;

  /** Paths of the pages the workshop already has, for numbering. */
  existingPages?: string[];

  /** Terminal session name that needs no `session` option. */
  defaultSession?: string;
}

const PLACEHOLDER = 'Explain this step.';

/**
 * Validate a parsed recording file.
 */
export function parseRecording(value: unknown): IRecording {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.events)) {
    throw new WorkshopFormatError(
      'A recording is an object with version 1 and an events list'
    );
  }

  const events: RecordedEvent[] = [];

  for (const item of value.events) {
    if (!isRecord(item) || typeof item.kind !== 'string') {
      throw new WorkshopFormatError('Each recorded event needs a kind');
    }

    events.push(item as unknown as RecordedEvent);
  }

  return {
    version: 1,
    started: typeof value.started === 'string' ? value.started : '',
    events
  };
}

/** Directive blocks drafted from events, with the capabilities they need. */
export interface IDraftBlocks {
  blocks: string[];
  capabilities: string[];
}

/**
 * Draft a placeholder paragraph and a directive for each event, ignoring
 * page markers.
 */
export function draftBlocks(
  events: RecordedEvent[],
  options: Pick<IDraftOptions, 'defaultSession'> = {}
): IDraftBlocks {
  const defaultSession = options.defaultSession ?? 'workshop';
  const capabilities = new Set<string>();
  const blocks: string[] = [];
  let previousPath = '';

  for (const event of events) {
    switch (event.kind) {
      case 'page-break':
        break;

      case 'terminal': {
        const command = event.command.trim();

        if (command === '') {
          break;
        }

        const draftOptions: Record<string, string> = {};

        if (event.session && event.session !== defaultSession) {
          draftOptions.session = event.session;
        }

        const note = event.uncertain
          ? ' (Check this command: completion or history was used while typing it.)'
          : '';

        blocks.push(
          `${PLACEHOLDER}${note}\n\n${serializeDirective({
            name: 'execute',
            options: draftOptions,
            body: command
          })}`
        );
        capabilities.add('terminal');
        break;
      }

      case 'file-saved': {
        const replacement =
          event.previous === null
            ? null
            : replacementFor(event.previous, event.content);

        if (replacement) {
          blocks.push(
            `${PLACEHOLDER}\n\n${serializeDirective({
              name: 'editor-replace',
              options: { path: event.path, match: replacement.match },
              body: replacement.text
            })}`
          );
        } else {
          blocks.push(
            `${PLACEHOLDER}\n\n${serializeDirective({
              name: 'file-write',
              options: { path: event.path, open: 'true' },
              body: event.content
            })}`
          );
        }

        capabilities.add('write-files:workspace');
        break;
      }

      case 'cell-executed':
        blocks.push(
          `${PLACEHOLDER}\n\n${serializeDirective({
            name: 'cell-insert',
            options: { path: event.path, run: 'true' },
            body: event.source
          })}`
        );
        capabilities.add('write-files:workspace');
        capabilities.add('kernel-exec');
        break;

      case 'file-opened':
        // Opening a file that was just written or run is implied.
        if (event.path === previousPath) {
          break;
        }

        blocks.push(
          `${PLACEHOLDER}\n\n${serializeDirective({
            name: event.path.endsWith('.ipynb') ? 'notebook-open' : 'file-open',
            options: { path: event.path },
            body: ''
          })}`
        );
        break;
    }

    previousPath = 'path' in event ? event.path : '';
  }

  return { blocks, capabilities: [...capabilities] };
}

/**
 * Draft pages from a recording, splitting at the page markers.
 */
export function draftFromRecording(
  recording: IRecording,
  options: IDraftOptions = {}
): IDraftWorkshop {
  const existing = [...(options.existingPages ?? [])];
  const capabilities = new Set<string>();
  const pages: IDraftPage[] = [];

  // Group the events between markers, then draft each group.
  let title = options.firstTitle ?? 'Getting started';
  let group: RecordedEvent[] = [];

  const flush = (): void => {
    const drafted = draftBlocks(group, options);

    group = [];

    if (drafted.blocks.length === 0) {
      return;
    }

    for (const capability of drafted.capabilities) {
      capabilities.add(capability);
    }

    const path = newPagePath(title, existing);
    const source = `---\ntitle: ${title}\n---\n\n# ${title}\n\n${drafted.blocks.join('\n\n')}\n`;

    existing.push(path);
    pages.push({ path, title, source });
  };

  for (const event of recording.events) {
    if (event.kind === 'page-break') {
      flush();
      title = event.title.trim() || `Page ${pages.length + 1}`;
    } else {
      group.push(event);
    }
  }

  flush();

  return { pages, capabilities: [...capabilities] };
}

/**
 * A minimal manifest for a workshop drafted from a recording.
 */
export function draftManifest(
  name: string,
  title: string,
  draft: IDraftWorkshop
): string {
  const capabilities = draft.capabilities.map(item => {
    const colon = item.indexOf(':');

    return colon < 0
      ? `  - ${item}`
      : `  - ${item.slice(0, colon)}: [${item.slice(colon + 1)}]`;
  });
  const head = [
    'apiVersion: workshop.educates.dev/v1alpha1',
    `name: ${name}`,
    `title: ${title}`,
    'version: 0.1.0',
    'description: Drafted from a recorded session; describe the workshop here.',
    'platforms: [linux, macos]',
    capabilities.length > 0 ? 'capabilities:' : 'capabilities: []',
    ...capabilities,
    'gating: soft',
    'pages: []',
    ''
  ].join('\n');

  return setManifestPages(
    head,
    draft.pages.map(page => page.path)
  );
}

/**
 * When a save changed exactly one line, describe it as an editor-replace
 * so the draft shows the edit rather than the whole file.
 */
function replacementFor(
  previous: string,
  content: string
): { match: string; text: string } | null {
  const diff = lineDiff(previous, content);
  const removed = diff.filter(line => line.kind === 'remove');
  const added = diff.filter(line => line.kind === 'add');

  if (removed.length !== 1 || added.length === 0) {
    return null;
  }

  // The changed lines must sit together, and the removed line must be
  // unique in the old file for a match to find it.
  const first = diff.findIndex(line => line.kind !== 'same');
  const last =
    diff.length -
    1 -
    [...diff].reverse().findIndex(line => line.kind !== 'same');
  const contiguous = diff
    .slice(first, last + 1)
    .every(line => line.kind !== 'same');
  const match = removed[0].text;

  if (
    !contiguous ||
    match.trim() === '' ||
    previous.split(match).length !== 2
  ) {
    return null;
  }

  return { match, text: added.map(line => line.text).join('\n') };
}
