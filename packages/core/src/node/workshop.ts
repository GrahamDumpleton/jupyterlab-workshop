/**
 * Loading a workshop from the file system for Node tooling: the CLI's
 * lint and render commands. Nothing here is used by the browser bundle.
 */

import * as fs from 'fs';
import * as path from 'path';

import { IWorkshopManifest, parseManifest } from '../format/manifest';
import { IPage, parsePage } from '../format/page';
import { declaredVariables } from '../format/page';
import { PLATFORM_NAMES } from '../format/variants';
import { Variables } from '../variables/substitute';

/** A workshop read from disk. */
export interface ILoadedWorkshopFiles {
  directory: string;
  manifest: IWorkshopManifest;
  manifestSource: string;
  pages: IPage[];

  /** The platform the pages were rendered for. */
  platform: string;
}

/** Options for loading a workshop. */
export interface ILoadOptions {
  /** Platform to render body variants for; `linux` by default. */
  platform?: string;
}

/** Built-in variables as the linter assumes them, per platform. */
const BUILTINS: Readonly<Record<string, Variables>> = {
  linux: {
    platform: 'linux',
    shell: 'bash',
    path_sep: '/',
    workshop_dir: '.',
    home: '/home/learner',
    user: 'learner',
    lite: 'false',
    hub: 'false'
  },
  macos: {
    platform: 'macos',
    shell: 'zsh',
    path_sep: '/',
    workshop_dir: '.',
    home: '/Users/learner',
    user: 'learner',
    lite: 'false',
    hub: 'false'
  },
  windows: {
    platform: 'windows',
    shell: 'powershell',
    path_sep: '\\',
    workshop_dir: '.',
    home: 'C:\\Users\\learner',
    user: 'learner',
    lite: 'false',
    hub: 'false'
  },
  lite: {
    platform: 'lite',
    shell: '',
    path_sep: '/',
    workshop_dir: '.',
    home: '/home/learner',
    user: 'learner',
    lite: 'true',
    hub: 'false'
  }
};

/**
 * Read and parse a workshop directory, rendering pages with the manifest
 * defaults so substituted arguments look as a learner would first see them.
 */
export function loadWorkshopFiles(
  directory: string,
  options: ILoadOptions = {}
): ILoadedWorkshopFiles {
  const platform = options.platform ?? 'linux';

  if (!PLATFORM_NAMES.includes(platform)) {
    throw new Error(
      `Unknown platform "${platform}"; expected one of ${PLATFORM_NAMES.join(', ')}`
    );
  }

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
  const builtins = BUILTINS[platform];
  const variables: Variables = { ...builtins };
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
      pathSep: builtins.path_sep,
      declared,
      platform
    })
  );

  return { directory, manifest, manifestSource, pages, platform };
}
