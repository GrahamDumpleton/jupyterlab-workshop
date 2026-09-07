import { ISettingRegistry } from '@jupyterlab/settingregistry';

/** Id of the plugin whose settings hold the workshop configuration. */
export const PANEL_PLUGIN_ID = '@jupyterlab-workshop/labextension:panel';

/**
 * Read a string setting of the panel plugin, or the fallback.
 */
export async function readSetting(
  settingRegistry: ISettingRegistry | null,
  key: string,
  fallback: string
): Promise<string> {
  if (!settingRegistry) {
    return fallback;
  }

  try {
    const settings = await settingRegistry.load(PANEL_PLUGIN_ID);
    const value = settings.get(key).composite;

    return typeof value === 'string' ? value : fallback;
  } catch (error) {
    console.error('Failed to load workshop settings', error);

    return fallback;
  }
}

/**
 * Read a boolean setting of the panel plugin, or the fallback.
 */
export async function readFlag(
  settingRegistry: ISettingRegistry | null,
  key: string,
  fallback: boolean
): Promise<boolean> {
  if (!settingRegistry) {
    return fallback;
  }

  try {
    const settings = await settingRegistry.load(PANEL_PLUGIN_ID);
    const value = settings.get(key).composite;

    return typeof value === 'boolean' ? value : fallback;
  } catch (error) {
    console.error('Failed to load workshop settings', error);

    return fallback;
  }
}

/**
 * Read a list-of-strings setting of the panel plugin, or an empty list.
 */
export async function readSettingList(
  settingRegistry: ISettingRegistry | null,
  key: string
): Promise<string[]> {
  if (!settingRegistry) {
    return [];
  }

  try {
    const settings = await settingRegistry.load(PANEL_PLUGIN_ID);
    const value = settings.get(key).composite;

    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : [];
  } catch (error) {
    console.error('Failed to load workshop settings', error);

    return [];
  }
}

/**
 * Write a list-of-strings setting of the panel plugin into the user's
 * settings, replacing the whole list. The composite value read back
 * afterwards is this list, whatever the defaults or overrides held.
 */
export async function writeSettingList(
  settingRegistry: ISettingRegistry | null,
  key: string,
  value: readonly string[]
): Promise<void> {
  if (!settingRegistry) {
    throw new Error('Settings are not available');
  }

  const settings = await settingRegistry.load(PANEL_PLUGIN_ID);

  await settings.set(key, [...value]);
}

/**
 * The value of a list setting the user set themselves, or null when the
 * list comes from the defaults or an administrator's overrides.
 */
export async function readUserSettingList(
  settingRegistry: ISettingRegistry | null,
  key: string
): Promise<string[] | null> {
  if (!settingRegistry) {
    return null;
  }

  try {
    const settings = await settingRegistry.load(PANEL_PLUGIN_ID);
    const value = settings.get(key).user;

    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : null;
  } catch (error) {
    console.error('Failed to load workshop settings', error);

    return null;
  }
}
