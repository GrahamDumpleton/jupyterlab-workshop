import {
  assignCollectionDirectory,
  emptyLibrary,
  ILibrary,
  INSTALLED_DIRECTORY,
  joinLibraryPath,
  normalizeWorkshopsDirectory
} from '@jupyterlab-workshop/core';
import { PathExt } from '@jupyterlab/coreutils';
import { Contents } from '@jupyterlab/services';

import { ensureDirectory, getIfExists } from '../actions/contents';
import { WORKSHOP_STATE_DIR } from '../state';
import { IInstalledWorkshop, isDownloaded } from '../tokens';

/** One downloaded workshop the migration moves under `installed/`. */
export interface IMigrationMove {
  title: string;
  from: string;
  to: string;
}

/** One workshop the migration leaves where it is, and why. */
export interface IMigrationSkip {
  title: string;
  path: string;
  reason: string;
}

/** What making a workshops directory a library would do. */
export interface IMigrationPlan {
  /** The registry to write. */
  library: ILibrary;
  moves: IMigrationMove[];
  skipped: IMigrationSkip[];
}

/**
 * What making a workshops directory a library would do, without doing
 * it: the registry to write, carrying over the subscriptions the user
 * made in their settings (the defaults are left to keep applying), and
 * which downloaded workshops move into their collection's directory
 * under `installed/`. A workshop with an isolated environment stays,
 * since the environment and its kernel hold absolute paths a move would
 * break, and so does the one open now. Local directories stay where
 * they are, as their own.
 */
export async function planMigration(options: {
  contents: Contents.IManager;
  directory: string;
  installed: readonly IInstalledWorkshop[];

  /** The collections and catalogs the user subscribed to, or null. */
  collections: string[] | null;
  catalogs: string[] | null;

  /** The id of each collection, by location, where its index was read. */
  ids: ReadonlyMap<string, string | undefined>;

  /** The path of the open workshop, if any. */
  openPath: string | null;
}): Promise<IMigrationPlan> {
  const base = normalizeWorkshopsDirectory(options.directory);
  let library: ILibrary = emptyLibrary();

  if (options.collections !== null) {
    library = { ...library, collections: [...options.collections] };
  }

  if (options.catalogs !== null) {
    library = { ...library, catalogs: [...options.catalogs] };
  }

  const moves: IMigrationMove[] = [];
  const skipped: IMigrationSkip[] = [];

  for (const item of options.installed) {
    // Only what sits directly in the workshops directory, downloaded
    // from a collection, has a place under installed/.
    if (
      !isDownloaded(item) ||
      item.collection === null ||
      PathExt.dirname(item.path) !== base
    ) {
      continue;
    }

    if (item.path === options.openPath) {
      skipped.push({
        title: item.title,
        path: item.path,
        reason: 'it is open; close it and do this again to move it'
      });

      continue;
    }

    if (await hasEnvironment(options.contents, item.path)) {
      skipped.push({
        title: item.title,
        path: item.path,
        reason: 'it has its own Python environment, which a move would break'
      });

      continue;
    }

    const assigned = assignCollectionDirectory(
      library,
      item.collection,
      options.ids.get(item.collection)
    );

    library = assigned.library;
    moves.push({
      title: item.title,
      from: item.path,
      to: joinLibraryPath(
        base,
        INSTALLED_DIRECTORY,
        assigned.directory,
        item.name
      )
    });
  }

  return { library, moves, skipped };
}

/**
 * Carry out a migration plan: move each workshop, then write the
 * registry, so a failure part way leaves no registry pointing at
 * directories that were never filled. A move whose destination exists
 * already is skipped and reported rather than overwriting anything.
 * Returns the moves that could not be made.
 */
export async function runMigration(
  contents: Contents.IManager,
  plan: IMigrationPlan,
  write: (library: ILibrary) => Promise<void>
): Promise<IMigrationSkip[]> {
  const failed: IMigrationSkip[] = [];

  for (const move of plan.moves) {
    try {
      if (await getIfExists(contents, move.to, false)) {
        throw new Error(`${move.to} exists already`);
      }

      await ensureDirectory(contents, PathExt.dirname(move.to));
      await contents.rename(move.from, move.to);
    } catch (error) {
      failed.push({
        title: move.title,
        path: move.from,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }

  await write(plan.library);

  return failed;
}

async function hasEnvironment(
  contents: Contents.IManager,
  path: string
): Promise<boolean> {
  for (const name of ['environment.json', 'venv']) {
    if (
      await getIfExists(
        contents,
        PathExt.join(path, WORKSHOP_STATE_DIR, name),
        false
      )
    ) {
      return true;
    }
  }

  return false;
}
