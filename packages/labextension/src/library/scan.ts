import {
  catalogCollections,
  collectionTitle,
  collectionWorkshops,
  COLLECTIONS_DIRECTORY,
  COURSE_CATALOG,
  COURSE_COLLECTION,
  courseEntry,
  COURSES_DIRECTORY,
  courseWorkshops,
  DEFAULT_COURSE_WORKSHOPS,
  ILibrary,
  ILibraryCourse,
  INSTALLED_WORKSHOPS_DIRECTORY,
  joinLibraryPath,
  normalizeWorkshopsDirectory,
  PERSONAL_WORKSHOPS_DIRECTORY
} from '@jupyterlab-workshop/core';
import { Contents } from '@jupyterlab/services';

import { getIfExists, readIfExists } from '../actions/contents';
import { describeInstalled, listInstalled, MANIFEST_FILE } from '../installed';
import {
  ICourseSectionPlace,
  IInstalledWorkshop,
  isDownloaded,
  WorkshopKind
} from '../tokens';

/** A course of a workshop library, as the browser shows it. */
export interface ILibraryCourseInfo {
  /** Its directory under `personal/courses/`. */
  name: string;

  /** That directory, relative to the root. */
  path: string;

  /** Its workshops directory, relative to the root. */
  workshops: string;

  /** For a linked course, the directory it links to. */
  target: string | null;

  /** Whether it is linked in from outside rather than kept in the library. */
  linked: boolean;

  /**
   * Whether it is gone: a registered link whose target was removed, or
   * whose link was. A missing course can only be unlinked.
   */
  missing: boolean;
}

/**
 * Every workshop of a library, each with its kind: the plain listing of
 * the workshops directory, where a download counts as installed and a
 * local directory has no kind, then the workshops under
 * `installed/collections/` and `installed/workshops/`, which are
 * installed, `personal/workshops/` and each course. Mirrors the command
 * line's scan.
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

  const scan = async (path: string, kind: WorkshopKind): Promise<void> => {
    for (const child of await subdirectories(contents, path)) {
      const record = await describeInstalled(contents, child.path);

      if (record) {
        records.push({ ...record, kind });
      }
    }
  };

  for (const collection of await subdirectories(
    contents,
    joinLibraryPath(base, COLLECTIONS_DIRECTORY)
  )) {
    await scan(collection.path, 'installed');
  }

  await scan(joinLibraryPath(base, INSTALLED_WORKSHOPS_DIRECTORY), 'installed');

  await scan(joinLibraryPath(base, PERSONAL_WORKSHOPS_DIRECTORY), 'personal');

  for (const course of await listCourses(contents, directory, library)) {
    if (course.missing) {
      continue;
    }

    const listed = new Map<string, IInstalledWorkshop>();
    const sections = await courseSections(
      contents,
      course.path,
      courseEntry(library, course.name)
    );

    // A workshop listed in two collections is one record, shown in each
    // of its sections.
    for (const [index, section] of sections.entries()) {
      for (const [position, path] of section.paths.entries()) {
        let record = listed.get(path);

        if (!record) {
          const described = await describeInstalled(
            contents,
            joinLibraryPath(course.path, path)
          );

          if (!described) {
            continue;
          }

          record = {
            ...described,
            kind: 'course',
            course: course.name,
            sections: []
          };
          listed.set(path, record);
          records.push(record);
        }

        const place: ICourseSectionPlace = {
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

/** A section of a course's workshops, by their paths in the course. */
export interface ICourseSection {
  title: string | null;
  paths: string[];
}

/**
 * The workshops of a course, in sections. The first rule that finds
 * anything decides. A `workshops` directory named in the course's
 * registry entry wins, as a choice made on purpose. Then the course's
 * own index: each collection its top-level `catalog.json` lists inside
 * it, in catalog order, or else its top-level `collection.json`, each a
 * section titled after the collection with its workshops in index
 * order, followed by a section with no title for workshops under
 * `workshops/` no index lists yet. Then the course itself when it is a
 * workshop, then the workshops directly under `workshops/`, then those
 * at the top of the course. Nothing deeper is read, so a submodule with
 * workshops of its own is not taken for the course's. Mirrors the
 * command line's `course_sections`.
 */
export async function courseSections(
  contents: Contents.IManager,
  coursePath: string,
  entry: ILibraryCourse
): Promise<ICourseSection[]> {
  const at = (path: string): string => joinLibraryPath(coursePath, path);

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

  const sections: ICourseSection[] = [];

  for (const collection of catalogCollections(
    await readJson(COURSE_CATALOG),
    COURSE_CATALOG
  )) {
    const index = await readJson(collection.path);
    const paths = await listedIn(index);

    if (paths.length > 0) {
      sections.push({ title: collectionTitle(index, collection.title), paths });
    }
  }

  if (sections.length === 0) {
    const index = await readJson(COURSE_COLLECTION);
    const paths = await listedIn(index);

    if (paths.length > 0) {
      sections.push({
        title: collectionTitle(index, coursePath.split('/').pop() ?? ''),
        paths
      });
    }
  }

  if (sections.length > 0) {
    const listed = new Set(sections.flatMap(section => section.paths));
    const rest = (await workshopsIn(DEFAULT_COURSE_WORKSHOPS)).filter(
      path => !listed.has(path)
    );

    return rest.length > 0
      ? [...sections, { title: null, paths: rest }]
      : sections;
  }

  if (await isWorkshop('')) {
    return [{ title: null, paths: [''] }];
  }

  if (await getIfExists(contents, at(DEFAULT_COURSE_WORKSHOPS), false)) {
    return [
      { title: null, paths: await workshopsIn(DEFAULT_COURSE_WORKSHOPS) }
    ];
  }

  return [{ title: null, paths: await workshopsIn('') }];
}

/**
 * The courses of a library in name order: the directories under
 * `personal/courses/`, and the linked courses the registry names, with
 * those whose directory has gone marked missing.
 */
export async function listCourses(
  contents: Contents.IManager,
  directory: string,
  library: ILibrary
): Promise<ILibraryCourseInfo[]> {
  const base = normalizeWorkshopsDirectory(directory);
  const coursesPath = joinLibraryPath(base, COURSES_DIRECTORY);
  const present = new Set(
    (await subdirectories(contents, coursesPath)).map(child => child.name)
  );
  const names = new Set(present);

  for (const course of library.courses ?? []) {
    if (course.target !== undefined) {
      names.add(course.name);
    }
  }

  return [...names].sort().map(name => {
    const entry = courseEntry(library, name);
    const path = joinLibraryPath(coursesPath, name);

    return {
      name,
      path,
      workshops: joinLibraryPath(path, courseWorkshops(entry)),
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
