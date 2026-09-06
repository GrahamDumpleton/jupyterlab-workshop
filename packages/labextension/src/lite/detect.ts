import { JupyterFrontEnd } from '@jupyterlab/application';
import { PageConfig } from '@jupyterlab/coreutils';

import { IPlatformInfo } from '../tokens';

/**
 * The platform as seen from inside JupyterLite: no operating system, a
 * cockle shell in the terminal, and files under `/drive`, which is where
 * both the Pyodide kernel and the terminal mount the browser's contents.
 */
export const LITE_PLATFORM: IPlatformInfo = {
  os: 'lite',
  shell: 'cockle',
  home: '/home/web_user',
  user: 'web_user',
  path_sep: '/',
  root_dir: '/drive',
  hub_user: '',
  host: 'lite',
  container: false
};

/**
 * Whether the application is JupyterLite rather than a JupyterLab served
 * by a Jupyter Server. JupyterLite names itself in the page configuration
 * it generates, and its application object carries the same name.
 */
export function isJupyterLite(app: JupyterFrontEnd): boolean {
  return (
    PageConfig.getOption('appName') === 'JupyterLite' ||
    app.name === 'JupyterLite'
  );
}
