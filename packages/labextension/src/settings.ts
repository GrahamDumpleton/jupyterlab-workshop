import { ISettingRegistry } from '@jupyterlab/settingregistry';

/** Id of the plugin whose settings hold the workshop configuration. */
export const PANEL_PLUGIN_ID = '@educates/jupyterlab-workshop:panel';

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
