import { PathExt } from '@jupyterlab/coreutils';
import { Contents } from '@jupyterlab/services';

import { deleteTree, getIfExists } from '../actions/contents';
import { MANIFEST_FILE } from '../installed';

export { describeInstalled, listInstalled } from '../installed';

/**
 * Delete a workshop directory, refusing anything without a manifest so a
 * wrong path cannot take out something else.
 */
export async function removeInstalled(
  contents: Contents.IManager,
  path: string
): Promise<void> {
  if (path === '' || path === '.') {
    throw new Error('Refusing to remove the root directory');
  }

  const manifest = await getIfExists(
    contents,
    PathExt.join(path, MANIFEST_FILE),
    false
  );

  if (!manifest) {
    throw new Error(`${path} is not a workshop directory`);
  }

  await deleteTree(contents, path);
}
