/**
 * Writing a recording's draft pages into a workshop directory for the
 * `jupyter workshop record` command.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  addManifestCapability,
  draftFromRecording,
  draftManifest,
  manifestList,
  parseRecording,
  setManifestPages
} from '../authoring';

/** What drafting wrote. */
export interface IDraftReport {
  directory: string;
  created: boolean;
  files: string[];
}

/** Names for a workshop created by drafting. */
export interface IDraftTarget {
  name?: string;
  title?: string;
}

/**
 * Read a recording file and write its draft pages into a directory,
 * creating the workshop when the directory has no manifest yet and
 * otherwise appending the pages to the existing one.
 */
export function draftToDirectory(
  recordingPath: string,
  directory: string,
  target: IDraftTarget = {}
): IDraftReport {
  const recording = parseRecording(
    JSON.parse(fs.readFileSync(recordingPath, 'utf8'))
  );
  const manifestPath = path.join(directory, 'workshop.yaml');
  const created = !fs.existsSync(manifestPath);
  const files: string[] = [];

  // An existing manifest supplies the page numbering and receives the
  // new pages and capabilities; otherwise a minimal manifest is written.
  let manifest = created ? '' : fs.readFileSync(manifestPath, 'utf8');
  const existingPages = created
    ? []
    : manifestList(manifest, 'pages').map(String);
  const draft = draftFromRecording(recording, { existingPages });

  if (draft.pages.length === 0) {
    throw new Error('The recording holds nothing to draft pages from');
  }

  if (created) {
    const name = target.name ?? path.basename(path.resolve(directory));
    const title = target.title ?? name.replace(/-/g, ' ');

    manifest = draftManifest(name, title, draft);
  } else {
    manifest = setManifestPages(manifest, [
      ...existingPages,
      ...draft.pages.map(page => page.path)
    ]);

    for (const capability of draft.capabilities) {
      manifest = addManifestCapability(manifest, capability);
    }
  }

  fs.mkdirSync(path.join(directory, 'pages'), { recursive: true });

  for (const page of draft.pages) {
    fs.writeFileSync(path.join(directory, page.path), page.source);
    files.push(page.path);
  }

  fs.writeFileSync(manifestPath, manifest);
  files.push('workshop.yaml');

  return { directory, created, files };
}
