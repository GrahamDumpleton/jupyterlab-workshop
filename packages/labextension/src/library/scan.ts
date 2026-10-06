import {
  catalogCollections,
  collectionTitle,
  collectionWorkshops,
  COLLECTIONS_DIRECTORY,
  DEFAULT_PROJECT_WORKSHOPS,
  ILibrary,
  ILibraryProject,
  joinLibraryPath,
  normalizeWorkshopsDirectory,
  PERSONAL_DIRECTORY,
  PROJECT_CATALOG,
  PROJECT_COLLECTION,
  projectEntry,
  projectWorkshops,
  PROJECTS_DIRECTORY,
  STANDALONE_DIRECTORY
} from '@jupyterlab-workshop/core';
import { Contents } from '@jupyterlab/services';

import { getIfExists, readIfExists } from '../actions/contents';
import { describeInstalled, listInstalled, MANIFEST_FILE } from '../installed';
import {
  IInstalledWorkshop,
  IProjectSectionPlace,
  isDownloaded,
  WorkshopKind
} from '../tokens';

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
 * local directory has no kind, then the workshops under `collections/`
 * and `standalone/`, which are installed, `personal/` and each
 * project. Mirrors the command line's scan.
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
    joinLibraryPath(base, COLLECTIONS_DIRECTORY)
  )) {
    await scan(collection.path, 'installed');
  }

  await scan(joinLibraryPath(base, STANDALONE_DIRECTORY), 'installed');

  await scan(joinLibraryPath(base, PERSONAL_DIRECTORY), 'personal');

  for (const project of await listProjects(contents, directory, library)) {
    if (project.missing) {
      continue;
    }

    const listed = new Map<string, IInstalledWorkshop>();
    const sections = await projectSections(
      contents,
      project.path,
      projectEntry(library, project.name)
    );

    // A workshop listed in two collections is one record, shown in each
    // of its sections.
    for (const [index, section] of sections.entries()) {
      for (const [position, path] of section.paths.entries()) {
        let record = listed.get(path);

        if (!record) {
          const described = await describeInstalled(
            contents,
            joinLibraryPath(project.path, path)
          );

          if (!described) {
            continue;
          }

          record = {
            ...described,
            kind: 'project',
            project: project.name,
            sections: []
          };
          listed.set(path, record);
          records.push(record);
        }

        const place: IProjectSectionPlace = {
          title: section.title,
          index,
          position
        };

        record.sections?.push(place);
      }
    }
  }

  records.sort((a, b) =>
    a.title.toLowerCase().localeCompare(b.title.toLowerCase())
  );

  return records;
}

/** A section of a project's workshops, by their paths in the project. */
export interface IProjectSection {
  title: string | null;
  paths: string[];
}

/**
 * The workshops of a project, in sections. The first rule that finds
 * anything decides. A `workshops` directory named in the project's
 * registry entry wins, as a choice made on purpose. Then the project's
 * own index: each collection its top-level `catalog.json` lists inside
 * it, in catalog order, or else its top-level `collection.json`, each a
 * section titled after the collection with its workshops in index
 * order, followed by a section with no title for workshops under
 * `workshops/` no index lists yet. Then the project itself when it is a
 * workshop, then the workshops directly under `workshops/`, then those
 * at the top of the project. Nothing deeper is read, so a submodule
 * with workshops of its own is not taken for the project's. Mirrors the
 * command line's `project_sections`.
 */
export async function projectSections(
  contents: Contents.IManager,
  projectPath: string,
  entry: ILibraryProject
): Promise<IProjectSection[]> {
  const at = (path: string): string => joinLibraryPath(projectPath, path);

  const isWorkshop = async (path: string): Promise<boolean> =>
    (await getIfExists(
      contents,
      joinLibraryPath(at(path), MANIFEST_FILE),
      false
    )) !== null;

  const workshopsIn = async (path: string): Promise<string[]> => {
    if (await isWorkshop(path)) {
      return [path];
    }

    const children = await subdirectories(contents, at(path));
    const found: string[] = [];

    for (const child of [...children].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    )) {
      const relative = joinLibraryPath(path, child.name);

      if (await isWorkshop(relative)) {
        found.push(relative);
      }
    }

    return found;
  };

  const readJson = async (path: string): Promise<unknown> => {
    try {
      const text = await readIfExists(contents, at(path));

      return text === null ? null : (JSON.parse(text) as unknown);
    } catch {
      return null;
    }
  };

  const listedIn = async (index: unknown): Promise<string[]> => {
    const found: string[] = [];

    for (const path of collectionWorkshops(index)) {
      if (await isWorkshop(path)) {
        found.push(path);
      }
    }

    return found;
  };

  if (entry.workshops) {
    return [
      {
        title: null,
        paths: await workshopsIn(entry.workshops.replace(/^\/+|\/+$/g, ''))
      }
    ];
  }

  const sections: IProjectSection[] = [];

  for (const collection of catalogCollections(
    await readJson(PROJECT_CATALOG),
    PROJECT_CATALOG
  )) {
    const index = await readJson(collection.path);
    const paths = await listedIn(index);

    if (paths.length > 0) {
      sections.push({ title: collectionTitle(index, collection.title), paths });
    }
  }

  if (sections.length === 0) {
    const index = await readJson(PROJECT_COLLECTION);
    const paths = await listedIn(index);

    if (paths.length > 0) {
      sections.push({
        title: collectionTitle(index, projectPath.split('/').pop() ?? ''),
        paths
      });
    }
  }

  if (sections.length > 0) {
    const listed = new Set(sections.flatMap(section => section.paths));
    const rest = (await workshopsIn(DEFAULT_PROJECT_WORKSHOPS)).filter(
      path => !listed.has(path)
    );

    return rest.length > 0
      ? [...sections, { title: null, paths: rest }]
      : sections;
  }

  if (await isWorkshop('')) {
    return [{ title: null, paths: [''] }];
  }

  if (await getIfExists(contents, at(DEFAULT_PROJECT_WORKSHOPS), false)) {
    return [
      { title: null, paths: await workshopsIn(DEFAULT_PROJECT_WORKSHOPS) }
    ];
  }

  return [{ title: null, paths: await workshopsIn('') }];
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
