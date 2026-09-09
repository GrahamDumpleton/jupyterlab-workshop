import { PageConfig } from '@jupyterlab/coreutils';
import { IStateDB } from '@jupyterlab/statedb';
import { ReadonlyPartialJSONValue } from '@lumino/coreutils';

/**
 * Values the extension keeps in the state database, kept apart by server.
 *
 * JupyterLab's state database lives in the workspace file, which is per
 * user and per workspace name, not per server. Every server the user runs
 * reads and writes the same file, but the paths the extension stores are
 * relative to a server's root, so an entry written under one root must
 * not be read under another. Each key therefore holds a map from server
 * root to that server's value.
 */
interface IServerScoped {
  servers: Record<string, ReadonlyPartialJSONValue>;
}

/**
 * The root directory of the server this page is served from, as the key
 * under which this server's state is kept.
 *
 * JupyterLite has no server root and only one root to speak of, so its
 * key is the empty string.
 */
export function serverRoot(): string {
  return PageConfig.getOption('serverRoot');
}

/**
 * Read this server's value under a key, or undefined when there is none.
 */
export async function fetchForServer(
  stateDB: IStateDB,
  key: string
): Promise<ReadonlyPartialJSONValue | undefined> {
  const stored = await stateDB.fetch(key);

  return isServerScoped(stored) ? stored.servers[serverRoot()] : undefined;
}

/**
 * Save this server's value under a key, keeping other servers' values.
 */
export async function saveForServer(
  stateDB: IStateDB,
  key: string,
  value: ReadonlyPartialJSONValue
): Promise<void> {
  const stored = await stateDB.fetch(key);
  const servers = isServerScoped(stored) ? { ...stored.servers } : {};

  servers[serverRoot()] = value;

  await stateDB.save(key, { servers } as unknown as ReadonlyPartialJSONValue);
}

function isServerScoped(value: unknown): value is IServerScoped {
  const servers = (value as { servers?: unknown } | undefined)?.servers;

  return typeof servers === 'object' && servers !== null;
}
