/**
 * Loading a workshop from the file system for Node tooling: the CLI's
 * lint and render commands. Nothing here is used by the browser bundle.
 */

import * as fs from 'fs';
import * as path from 'path';

import { IWorkshopManifest, parseManifest } from '../format/manifest';
import { IPage, parsePage } from '../format/page';
import { declaredVariables } from '../format/page';
import { Variables } from '../variables/substitute';

/** A workshop read from disk. */
export interface ILoadedWorkshopFiles {
  directory: string;
  manifest: IWorkshopManifest;
  manifestSource: string;
  pages: IPage[];
}

/** Built-in variables as the linter assumes them. */
const BUILTINS: Variables = {
  platform: 'linux',
  shell: 'bash',
  path_sep: '/',
  workshop_dir: '.',
  home: '/home/learner',
  user: 'learner',
  lite: 'false',
  hub: 'false'
};

/**
 * Read and parse a workshop directory, rendering pages with the manifest
 * defaults so substituted arguments look as a learner would first see them.
 */
export function loadWorkshopFiles(directory: string): ILoadedWorkshopFiles {
  const manifestPath = path.join(directory, 'workshop.yaml');

  if (!fs.existsSync(manifestPath)) {
    throw new Error(`${directory} has no workshop.yaml`);
  }

  const manifestSource = fs.readFileSync(manifestPath, 'utf8');
  const manifest = parseManifest(manifestSource, 'workshop.yaml');
  const sources = new Map<string, string>();

  for (const pagePath of manifest.pages) {
    const file = path.join(directory, pagePath);

    if (!fs.existsSync(file)) {
      throw new Error(
        `Page ${pagePath} listed in workshop.yaml does not exist`
      );
    }

    sources.set(pagePath, fs.readFileSync(file, 'utf8'));
  }

  // Names set anywhere in the workshop render as placeholders, not
  // warnings, the same way the extension treats them.
  const variables: Variables = { ...BUILTINS };
  const declared = new Set<string>(
    manifest.variables.map(definition => definition.name)
  );

  for (const definition of manifest.variables) {
    if (definition.default !== undefined) {
      variables[definition.name] = definition.default;
    }
  }

  for (const [pagePath, source] of sources) {
    const preview = parsePage(source, { path: pagePath, variables: {} });

    for (const name of declaredVariables(preview.nodes)) {
      declared.add(name);
    }
  }

  const pages = manifest.pages.map(pagePath =>
    parsePage(sources.get(pagePath) ?? '', {
      path: pagePath,
      variables,
      declared
    })
  );

  return { directory, manifest, manifestSource, pages };
}
