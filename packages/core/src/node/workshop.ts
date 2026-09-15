/**
 * Loading a workshop from the file system for Node tooling: the CLI's
 * lint and render commands. Nothing here is used by the browser bundle.
 */

import * as fs from 'fs';
import * as path from 'path';

import { IWorkshopManifest, parseManifest } from '../format/manifest';
import { IPage, parsePage } from '../format/page';
import { declaredVariables } from '../format/page';
import { FRONTEND_NAMES, PLATFORM_NAMES } from '../format/variants';
import { Variables } from '../variables/substitute';

/** A workshop read from disk. */
export interface ILoadedWorkshopFiles {
  directory: string;
  manifest: IWorkshopManifest;
  manifestSource: string;
  pages: IPage[];

  /** The platform the pages were rendered for. */
  platform: string;

  /** The frontend the pages were rendered for. */
  frontend: string;
}

/** Options for loading a workshop. */
export interface ILoadOptions {
  /** Platform to render body variants for; `linux` by default. */
  platform?: string;

  /**
   * Frontend to render body variants for; `jupyterlab` by default.
   * JupyterLite implies the `emscripten` platform whatever `platform`
   * says, since Pyodide reports that and nothing else runs there.
   */
  frontend?: string;
}

/** Built-in variables as the linter assumes them, per platform. */
const BUILTINS: Readonly<Record<string, Variables>> = {
  linux: {
    platform: 'linux',
    shell: 'bash',
    path_sep: '/',
    workshop_dir: '.',
    workspace: '.',
    home: '/home/learner',
    user: 'learner',
    host: 'local',
    container: 'false',
    frontend: 'jupyterlab'
  },
  macos: {
    platform: 'macos',
    shell: 'zsh',
    path_sep: '/',
    workshop_dir: '.',
    workspace: '.',
    home: '/Users/learner',
    user: 'learner',
    host: 'local',
    container: 'false',
    frontend: 'jupyterlab'
  },
  windows: {
    platform: 'windows',
    shell: 'powershell',
    path_sep: '\\',
    workshop_dir: '.',
    workspace: '.',
    home: 'C:\\Users\\learner',
    user: 'learner',
    host: 'local',
    container: 'false',
    frontend: 'jupyterlab'
  },
  emscripten: {
    platform: 'emscripten',
    shell: 'cockle',
    path_sep: '/',
    workshop_dir: '.',
    workspace: '.',
    home: '/home/web_user',
    user: 'web_user',
    host: 'static',
    container: 'false',
    frontend: 'jupyterlite'
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
  const frontend = options.frontend ?? 'jupyterlab';

  if (!FRONTEND_NAMES.includes(frontend)) {
    throw new Error(
      `Unknown frontend "${frontend}"; expected one of ${FRONTEND_NAMES.join(', ')}`
    );
  }

  const requested = options.platform ?? 'linux';

  if (!PLATFORM_NAMES.includes(requested)) {
    const hint =
      requested === 'lite' ? '; JupyterLite is "--frontend jupyterlite"' : '';

    throw new Error(
      `Unknown platform "${requested}"; expected one of ${PLATFORM_NAMES.join(', ')}${hint}`
    );
  }

  // JupyterLite runs on Pyodide whatever the browser's operating system.
  const platform = frontend === 'jupyterlite' ? 'emscripten' : requested;

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
  const variables: Variables = {
    ...builtins,
    workspace: manifest.workspace
  };
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
      platform,
      frontend
    })
  );

  return { directory, manifest, manifestSource, pages, platform, frontend };
}
