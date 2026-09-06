import { PathExt } from '@jupyterlab/coreutils';
import { Contents } from '@jupyterlab/services';

import {
  deleteTree,
  ensureDirectory,
  getIfExists,
  readIfExists,
  writeTextFile
} from '../actions/contents';
import { WORKSHOP_STATE_DIR } from '../state';
import { ICheckpointRecord } from '../tokens';

/**
 * Directory under the state directory holding the checkpoints. Not
 * "checkpoints": that name at the end of a contents API path is the
 * server's own checkpoints route, which would hide the directory.
 */
const CHECKPOINTS_DIR = 'snapshots';

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Snapshot a workshop by copying its files, except the state directory,
 * to `_workshop/snapshots/<name>/` through the contents API, with a
 * record of the variables beside it. This is how JupyterLite checkpoints
 * without a server to make an archive.
 */
export async function createCheckpoint(
  contents: Contents.IManager,
  workshop: string,
  name: string,
  variables: ICheckpointRecord['variables']
): Promise<ICheckpointRecord> {
  const checkpoint = checkName(name);
  const directory = PathExt.join(
    workshop,
    WORKSHOP_STATE_DIR,
    CHECKPOINTS_DIR,
    checkpoint
  );

  await deleteTree(contents, directory);
  await copyTree(contents, workshop, directory, [WORKSHOP_STATE_DIR]);

  const record: ICheckpointRecord = {
    name: checkpoint,
    createdAt: new Date().toISOString(),
    variables
  };

  await writeTextFile(
    contents,
    `${directory}.json`,
    JSON.stringify(record, null, 2)
  );

  return record;
}

/**
 * Replace the workshop's files with those of a checkpoint and return its
 * record. Files created after the checkpoint disappear, as on the server.
 */
export async function restoreCheckpoint(
  contents: Contents.IManager,
  workshop: string,
  name: string
): Promise<ICheckpointRecord> {
  const checkpoint = checkName(name);
  const directory = PathExt.join(
    workshop,
    WORKSHOP_STATE_DIR,
    CHECKPOINTS_DIR,
    checkpoint
  );
  const text = await readIfExists(contents, `${directory}.json`);

  if (text === null || !(await getIfExists(contents, directory, false))) {
    throw new Error(`There is no checkpoint named ${name}`);
  }

  const model = await contents.get(workshop, { content: true });

  for (const child of childrenOf(model)) {
    if (child.name === WORKSHOP_STATE_DIR) {
      continue;
    }

    if (child.type === 'directory') {
      await deleteTree(contents, child.path);
    } else {
      await contents.delete(child.path);
    }
  }

  await copyTree(contents, directory, workshop, []);

  const parsed = JSON.parse(text) as Partial<ICheckpointRecord>;

  return {
    name: parsed.name ?? checkpoint,
    createdAt: parsed.createdAt ?? '',
    variables: parsed.variables ?? {}
  };
}

/**
 * Copy a directory tree through the contents API, skipping the named
 * top-level entries.
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

function childrenOf(model: Contents.IModel): Contents.IModel[] {
  return model.type === 'directory' && Array.isArray(model.content)
    ? (model.content as Contents.IModel[])
    : [];
}

function checkName(name: string): string {
  if (!NAME.test(name)) {
    throw new Error(`"${name}" is not a valid checkpoint name`);
  }

  return name;
}
