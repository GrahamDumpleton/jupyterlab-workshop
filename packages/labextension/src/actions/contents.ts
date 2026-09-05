import { PathExt } from '@jupyterlab/coreutils';
import { Contents, ServerConnection } from '@jupyterlab/services';

/**
 * Fetch a path through the contents API, returning null when it does not
 * exist.
 */
export async function getIfExists(
  contents: Contents.IManager,
  path: string,
  withContent: boolean
): Promise<Contents.IModel | null> {
  try {
    return await contents.get(path, { content: withContent });
  } catch (error) {
    if (
      error instanceof ServerConnection.ResponseError &&
      error.response.status === 404
    ) {
      return null;
    }

    throw error;
  }
}

/**
 * Create a directory and any missing parents through the contents API.
 */
export async function ensureDirectory(
  contents: Contents.IManager,
  path: string
): Promise<void> {
  if (path === '' || path === '.') {
    return;
  }

  const existing = await getIfExists(contents, path, false);

  if (existing) {
    if (existing.type !== 'directory') {
      throw new Error(`${path} exists and is not a directory`);
    }

    return;
  }

  const parent = PathExt.dirname(path);

  await ensureDirectory(contents, parent);

  // The contents API only creates untitled directories, so rename one.
  const created = await contents.newUntitled({
    type: 'directory',
    path: parent
  });

  await contents.rename(created.path, path);
}

/**
 * Read a text file through the contents API, returning null when it does
 * not exist.
 */
export async function readIfExists(
  contents: Contents.IManager,
  path: string
): Promise<string | null> {
  try {
    return await readTextFile(contents, path);
  } catch (error) {
    if (
      error instanceof ServerConnection.ResponseError &&
      error.response.status === 404
    ) {
      return null;
    }

    throw error;
  }
}

/**
 * Read a text file through the contents API.
 */
export async function readTextFile(
  contents: Contents.IManager,
  path: string
): Promise<string> {
  const model = await contents.get(path, {
    content: true,
    type: 'file',
    format: 'text'
  });

  if (typeof model.content !== 'string') {
    throw new Error(`${path} is not a text file`);
  }

  return model.content;
}

/**
 * Write a text file through the contents API, creating directories.
 */
export async function writeTextFile(
  contents: Contents.IManager,
  path: string,
  content: string
): Promise<void> {
  await ensureDirectory(contents, PathExt.dirname(path));
  await contents.save(path, { type: 'file', format: 'text', content });
}
