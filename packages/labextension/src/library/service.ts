import {
  ILibrary,
  libraryFilePath,
  normalizeWorkshopsDirectory,
  parseLibrary,
  serializeLibrary
} from '@jupyterlab-workshop/core';
import { Contents } from '@jupyterlab/services';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { ISignal, Signal } from '@lumino/signaling';

import { readIfExists, writeTextFile } from '../actions/contents';
import { ILibraryProjectInfo, listProjects } from './scan';
import { readSetting } from '../settings';
import { IFeaturePolicy } from '../tokens';

/** The workshops directory when the settings do not name one. */
export const DEFAULT_WORKSHOPS_DIRECTORY = 'workshops';

/**
 * The workshop library, if the workshops directory is one: it reads and
 * writes the `library.json` registry through the contents API, so it
 * works the same in JupyterLab and JupyterLite.
 *
 * Whether there is a library is decided by the registry file alone, and
 * the workshops directory it is looked for in comes from the settings,
 * never from the registry, so finding a library cannot depend on it.
 * With the `library` feature disabled there is never a library, which
 * lets a deployment ignore a registry its directory happens to hold.
 */
export class LibraryService {
  constructor(options: LibraryService.IOptions) {
    this._contents = options.contents;
    this._features = options.features;
    this._settings = options.settingRegistry;
  }

  /** The contents manager the registry is read and written through. */
  get contents(): Contents.IManager {
    return this._contents;
  }

  /** Emitted when this service writes the registry. */
  get changed(): ISignal<this, void> {
    return this._changed;
  }

  /** Whether the settings allow libraries at all. */
  get enabled(): boolean {
    return this._features.enabled('library');
  }

  /** The workshops directory the settings name, as they spell it. */
  async workshopsDirectory(): Promise<string> {
    return readSetting(
      this._settings,
      'workshopsDirectory',
      DEFAULT_WORKSHOPS_DIRECTORY
    );
  }

  /**
   * The registry of a workshops directory, the configured one when none
   * is given, or null when it is not a library or libraries are
   * disabled. A registry that cannot be read or understood is an error,
   * rather than quietly treated as no library.
   */
  async read(directory?: string): Promise<ILibrary | null> {
    if (!this.enabled) {
      return null;
    }

    const path = libraryFilePath(
      directory ?? (await this.workshopsDirectory())
    );
    const text = await readIfExists(this._contents, path);

    if (text === null) {
      return null;
    }

    try {
      return parseLibrary(JSON.parse(text));
    } catch (error) {
      throw new Error(
        `The workshop library registry ${path} is invalid: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  /**
   * Re-read the registry, apply a change and write it back. Reading just
   * before writing keeps a change the command line made meanwhile.
   * Throws when the directory is not a library.
   */
  async update(
    change: (library: ILibrary) => ILibrary,
    directory?: string
  ): Promise<ILibrary> {
    const where = directory ?? (await this.workshopsDirectory());
    const current = await this.read(where);

    if (current === null) {
      throw new Error(`${where || 'The root'} is not a workshop library`);
    }

    const changed = change(current);

    if (changed !== current) {
      await this._write(where, changed);
    }

    return changed;
  }

  /**
   * Make a workshops directory a library by writing its registry.
   * Refuses when it is one already.
   */
  async create(library: ILibrary, directory?: string): Promise<void> {
    const where = directory ?? (await this.workshopsDirectory());

    if ((await readIfExists(this._contents, libraryFilePath(where))) !== null) {
      throw new Error(`${where || 'The root'} is a workshop library already`);
    }

    await this._write(where, library);
  }

  /**
   * The projects of a library, the configured workshops directory's when
   * none is given, with those whose directory has gone marked missing.
   */
  async projects(
    library: ILibrary,
    directory?: string
  ): Promise<ILibraryProjectInfo[]> {
    return listProjects(
      this._contents,
      directory ?? (await this.workshopsDirectory()),
      library
    );
  }

  /** A path in the configured workshops directory, joined without `./`. */
  async path(...parts: string[]): Promise<string> {
    return [
      normalizeWorkshopsDirectory(await this.workshopsDirectory()),
      ...parts
    ]
      .filter(part => part !== '')
      .join('/');
  }

  private async _write(directory: string, library: ILibrary): Promise<void> {
    await writeTextFile(
      this._contents,
      libraryFilePath(directory),
      serializeLibrary(parseLibrary(library))
    );
    this._changed.emit();
  }

  private _contents: Contents.IManager;
  private _features: IFeaturePolicy;
  private _settings: ISettingRegistry | null;
  private _changed = new Signal<this, void>(this);
}

export namespace LibraryService {
  export interface IOptions {
    contents: Contents.IManager;
    features: IFeaturePolicy;
    settingRegistry: ISettingRegistry | null;
  }
}
