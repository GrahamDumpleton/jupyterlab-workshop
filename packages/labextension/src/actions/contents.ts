import { PathExt } from '@jupyterlab/coreutils';
import { Contents, ServerConnection } from '@jupyterlab/services';

/**
 * Whether an error from the contents API means the path does not exist.
 * Jupyter Server answers 404; the in-browser contents of JupyterLite
 * throw a plain error saying the content could not be found.
 */
export function isNotFound(error: unknown): boolean {
  if (
    error instanceof ServerConnection.ResponseError &&
    error.response.status === 404
  ) {
    return true;
  }

  return (
    error instanceof Error &&
    /^Could not find (content|file)\b/.test(error.message)
  );
}

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
    if (isNotFound(error)) {
      return null;
    }

    throw error;
  }
}

/**
 * Delete a directory and everything in it through the contents API. Some
 * servers refuse non-empty directories, so the children go first.
 */
export async function deleteTree(
  contents: Contents.IManager,
  path: string
): Promise<void> {
  const model = await getIfExists(contents, path, true);

  if (!model) {
    return;
  }

  if (model.type === 'directory' && Array.isArray(model.content)) {
    for (const child of model.content as Contents.IModel[]) {
      if (child.type === 'directory') {
        await deleteTree(contents, child.path);
      } else {
        await contents.delete(child.path);
      }
    }
  }

  try {
    await contents.delete(path);
  } catch (error) {
    console.warn(`Unable to delete ${path}`, error);
  }
}

/**
 * Delete everything inside a directory except the entries named, leaving
 * the directory itself in place. A missing directory is not an error.
 */
export async function deleteChildrenExcept(
  contents: Contents.IManager,
  path: string,
  keep: ReadonlySet<string>
): Promise<void> {
  const model = await getIfExists(contents, path, true);

  if (!model || model.type !== 'directory' || !Array.isArray(model.content)) {
    return;
  }

  for (const child of model.content as Contents.IModel[]) {
    if (keep.has(child.name)) {
      continue;
    }

    if (child.type === 'directory') {
      await deleteTree(contents, child.path);
    } else {
      await contents.delete(child.path);
    }
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

  try {
    await contents.rename(created.path, path);
  } catch (error) {
    // Something else, such as the server appending to a file under the
    // same directory, may have created it between the check above and
    // the rename. That is fine, but the untitled directory must not be
    // left behind either way.
    await contents.delete(created.path).catch(() => undefined);

    const now = await getIfExists(contents, path, false);

    if (!now || now.type !== 'directory') {
      throw error;
    }
  }
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
    if (isNotFound(error)) {
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

/**
 * Copy a directory tree through the contents API, skipping the named
 * top-level entries. Files are read and written whole, since the server
 * cannot copy a directory in one request; a large tree takes a while.
 */
export async function copyTree(
  contents: Contents.IManager,
  from: string,
  to: string,
  skip: readonly string[]
): Promise<void> {
  const model = await contents.get(from, { content: true });

  await ensureDirectory(contents, to);

  for (const child of childrenOf(model)) {
    if (skip.includes(child.name)) {
      continue;
    }

    const target = PathExt.join(to, child.name);

    if (child.type === 'directory') {
      await copyTree(contents, child.path, target, []);
    } else {
      const file = await contents.get(child.path, { content: true });

      await contents.save(target, {
        type: file.type,
        format: file.format,
        content: file.content
      });
    }
  }
}

/**
 * The entries of a directory model, or nothing for a file.
 */
export function childrenOf(model: Contents.IModel): Contents.IModel[] {
  return model.type === 'directory' && Array.isArray(model.content)
    ? (model.content as Contents.IModel[])
    : [];
}
