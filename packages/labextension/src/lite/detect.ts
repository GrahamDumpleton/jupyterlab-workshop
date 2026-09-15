import { JupyterFrontEnd } from '@jupyterlab/application';
import { PageConfig } from '@jupyterlab/coreutils';

import { IPlatformInfo } from '../tokens';

/**
 * The platform as seen from inside JupyterLite: Pyodide's `emscripten`
 * for the operating system whatever the browser runs on, a cockle shell
 * in the terminal, files under `/drive`, which is where both the Pyodide
 * kernel and the terminal mount the browser's contents, and `static` for
 * the host, since a site has no service behind it. The instance id is
 * minted once per page load: a reload loses the kernel and the terminals
 * exactly as a restarted server does, so it is a new instance. The
 * version is what `jupyter workshop lite` wrote into the site's
 * configuration, or empty for a site built another way.
 */
export const LITE_PLATFORM: IPlatformInfo = {
  os: 'emscripten',
  shell: 'cockle',
  home: '/home/web_user',
  user: 'web_user',
  path_sep: '/',
  root_dir: '/drive',
  hub_user: '',
  host: 'static',
  container: false,
  frontend: 'jupyterlite',
  frontend_version: PageConfig.getOption('jupyterlabWorkshopVersion'),
  instance_id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
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
