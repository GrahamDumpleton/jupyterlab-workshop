import {
  ILibrary,
  INSTALLED_DIRECTORY,
  joinLibraryPath,
  normalizeWorkshopsDirectory,
  PERSONAL_DIRECTORY,
  projectEntry,
  projectWorkshops,
  PROJECTS_DIRECTORY
} from '@jupyterlab-workshop/core';
import { Contents } from '@jupyterlab/services';

import { getIfExists } from '../actions/contents';
import { describeInstalled, listInstalled, MANIFEST_FILE } from '../installed';
import { IInstalledWorkshop, isDownloaded, WorkshopKind } from '../tokens';

/** A project of a workshop library, as the browser shows it. */
export interface ILibraryProjectInfo {
  /** Its directory under `projects/`. */
  name: string;

  /** That directory, relative to the root. */
  path: string;

  /** Its workshops directory, relative to the root. */
  workshops: string;

  /** For a linked project, the directory it links to. */
  target: string | null;

  /** Whether it is linked in from outside rather than cloned in. */
  linked: boolean;

  /**
   * Whether it is gone: a registered link whose target was removed, or
   * whose link was. A missing project can only be unlinked.
   */
  missing: boolean;
}

/**
 * Every workshop of a library, each with its kind: the plain listing of
 * the workshops directory, where a download counts as installed and a
 * local directory has no kind, then the workshops under `installed/`,
 * `personal/` and each project. Mirrors the command line's scan.
 */
export async function listLibrary(
  contents: Contents.IManager,
  directory: string,
  library: ILibrary
): Promise<IInstalledWorkshop[]> {
  const base = normalizeWorkshopsDirectory(directory);
  const records: IInstalledWorkshop[] = (
    await listInstalled(contents, base)
  ).map(record => ({
    ...record,
    kind: isDownloaded(record) ? 'installed' : null
  }));

  const scan = async (
    path: string,
    kind: WorkshopKind,
    project?: string
  ): Promise<void> => {
    for (const child of await subdirectories(contents, path)) {
      const record = await describeInstalled(contents, child.path);

      if (record) {
        records.push(
          project ? { ...record, kind, project } : { ...record, kind }
        );
      }
    }
  };

  for (const collection of await subdirectories(
    contents,
    joinLibraryPath(base, INSTALLED_DIRECTORY)
  )) {
    await scan(collection.path, 'installed');
  }

  await scan(joinLibraryPath(base, PERSONAL_DIRECTORY), 'personal');

  for (const project of await listProjects(contents, directory, library)) {
    if (!project.missing) {
      await scan(project.workshops, 'project', project.name);
    }
  }

  records.sort((a, b) =>
    a.title.toLowerCase().localeCompare(b.title.toLowerCase())
  );

  return records;
}

/**
 * The projects of a library in name order: the directories under
 * `projects/`, and the linked projects the registry names, with those
 * whose directory has gone marked missing.
 */
export async function listProjects(
  contents: Contents.IManager,
  directory: string,
  library: ILibrary
): Promise<ILibraryProjectInfo[]> {
  const base = normalizeWorkshopsDirectory(directory);
  const projectsPath = joinLibraryPath(base, PROJECTS_DIRECTORY);
  const present = new Set(
    (await subdirectories(contents, projectsPath)).map(child => child.name)
  );
  const names = new Set(present);

  for (const project of library.projects ?? []) {
    if (project.target !== undefined) {
      names.add(project.name);
    }
  }

  return [...names].sort().map(name => {
    const entry = projectEntry(library, name);
    const path = joinLibraryPath(projectsPath, name);

    return {
      name,
      path,
      workshops: joinLibraryPath(path, projectWorkshops(entry)),
      target: entry.target ?? null,
      linked: entry.target !== undefined,
      missing: !present.has(name)
    };
  });
}

/**
 * The directories directly under a path that are containers, not
 * workshops: nothing when the path is missing or is itself a workshop,
 * since a workshop is listed at its own level and never looked inside.
 */
async function subdirectories(
  contents: Contents.IManager,
  path: string
): Promise<Contents.IModel[]> {
  const model = await getIfExists(contents, path, true);

  if (!model || model.type !== 'directory' || !Array.isArray(model.content)) {
    return [];
  }

  const children = model.content as Contents.IModel[];

  if (children.some(child => child.name === MANIFEST_FILE)) {
    return [];
  }

  return children.filter(
    child => child.type === 'directory' && !child.name.startsWith('.')
  );
}
