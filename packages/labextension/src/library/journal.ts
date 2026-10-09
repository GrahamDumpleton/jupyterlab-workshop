import {
  JOURNAL_DIRECTORY,
  joinLibraryPath,
  normalizeWorkshopsDirectory
} from '@jupyterlab-workshop/core';
import { Contents } from '@jupyterlab/services';

import { getIfExists, readIfExists, writeTextFile } from '../actions/contents';

/** The learner's profile in a library's journal, written by the mentor. */
export const PROFILE_FILE = 'profile.md';

/** The journal's own settings. */
export const SETTINGS_FILE = 'settings.yaml';

/** The setting that says the welcome card was dismissed for good. */
const WELCOME_KEY = 'welcome_dismissed';

/** A path inside a library's journal. */
export function journalPath(
  workshopsDirectory: string,
  ...parts: string[]
): string {
  return joinLibraryPath(
    normalizeWorkshopsDirectory(workshopsDirectory),
    JOURNAL_DIRECTORY,
    ...parts
  );
}

/**
 * Whether the browser should still offer to meet the mentor: no profile
 * has been written and the welcome has not been dismissed for good.
 */
export async function welcomePending(
  contents: Contents.IManager,
  workshopsDirectory: string
): Promise<boolean> {
  const profile = await getIfExists(
    contents,
    journalPath(workshopsDirectory, PROFILE_FILE),
    false
  );

  if (profile !== null) {
    return false;
  }

  const settings = await readIfExists(
    contents,
    journalPath(workshopsDirectory, SETTINGS_FILE)
  );

  return !(settings !== null && dismissed(settings));
}

/**
 * Record in the journal's settings that the welcome is not to be shown
 * again, keeping whatever else the file says. The setting travels with
 * the library, and a reset of the journal clears it.
 */
export async function dismissWelcome(
  contents: Contents.IManager,
  workshopsDirectory: string
): Promise<void> {
  const path = journalPath(workshopsDirectory, SETTINGS_FILE);
  const existing = (await readIfExists(contents, path)) ?? 'version: 1\n';
  const line = `${WELCOME_KEY}: true`;
  const pattern = new RegExp(`^${WELCOME_KEY}:.*$`, 'm');
  const text = pattern.test(existing)
    ? existing.replace(pattern, line)
    : `${existing.replace(/\n*$/, '\n')}${line}\n`;

  await writeTextFile(contents, path, text);
}

function dismissed(settings: string): boolean {
  return new RegExp(`^${WELCOME_KEY}:\\s*true\\s*$`, 'm').test(settings);
}
