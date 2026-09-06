import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import { ISignal, Signal } from '@lumino/signaling';

import { PANEL_PLUGIN_ID } from './settings';
import { FEATURES, Feature, IFeaturePolicy } from './tokens';

/** The `disabledFeatures` setting of the panel plugin. */
const SETTING = 'disabledFeatures';

/**
 * The feature policy read from the `disabledFeatures` setting. An
 * administrator sets it through `overrides.json` to lock learners into
 * the workshops an image supplies: no opening other directories or URLs,
 * no editing, and so on.
 */
export class FeaturePolicy implements IFeaturePolicy {
  get changed(): ISignal<this, void> {
    return this._changed;
  }

  get disabled(): readonly Feature[] {
    return this._disabled;
  }

  enabled(feature: Feature): boolean {
    return !this._disabled.includes(feature);
  }

  /**
   * Read the setting and follow its changes. Without a setting registry
   * every feature stays enabled.
   */
  async load(settingRegistry: ISettingRegistry | null): Promise<void> {
    if (!settingRegistry) {
      return;
    }

    try {
      const settings = await settingRegistry.load(PANEL_PLUGIN_ID);

      this._apply(settings);
      settings.changed.connect(this._apply, this);
    } catch (error) {
      console.error('Failed to load workshop feature settings', error);
    }
  }

  private _apply(settings: ISettingRegistry.ISettings): void {
    const value = settings.get(SETTING).composite;
    const disabled = Array.isArray(value)
      ? value.filter((item): item is Feature =>
          (FEATURES as readonly string[]).includes(String(item))
        )
      : [];

    const same =
      disabled.length === this._disabled.length &&
      disabled.every(item => this._disabled.includes(item));

    if (same) {
      return;
    }

    this._disabled = disabled;
    this._changed.emit();
  }

  private _disabled: Feature[] = [];
  private _changed = new Signal<this, void>(this);
}

/**
 * Provides the feature policy. Activation waits for the settings so the
 * plugins that consume the policy find it loaded.
 */
export const featuresPlugin: JupyterFrontEndPlugin<IFeaturePolicy> = {
  id: '@jupyterlab-workshop/labextension:features',
  description: 'Reads which parts of the extension the settings disable.',
  autoStart: true,
  provides: IFeaturePolicy,
  optional: [ISettingRegistry],
  activate: async (
    app: JupyterFrontEnd,
    settingRegistry: ISettingRegistry | null
  ): Promise<IFeaturePolicy> => {
    const policy = new FeaturePolicy();

    await policy.load(settingRegistry);

    return policy;
  }
};
