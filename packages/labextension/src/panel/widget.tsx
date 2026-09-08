import { ReactWidget } from '@jupyterlab/ui-components';
import { CommandRegistry } from '@lumino/commands';
import React from 'react';

import { workshopIcon } from '../icons';
import { CommandIDs, IFeaturePolicy, IWorkshopManager } from '../tokens';
import { WorkshopPanelComponent } from './components';

/** Id of the panel widget, also used for layout restoration. */
export const PANEL_ID = 'jupyterlab-workshop-panel';

/**
 * The instructions panel shown in the left sidebar.
 */
export class WorkshopPanel extends ReactWidget {
  constructor(options: WorkshopPanel.IOptions) {
    super();

    this._manager = options.manager;
    this._commands = options.commands;
    this._features = options.features;
    this._features.changed.connect(this.update, this);
    this._commands.commandChanged.connect(this._onCommandChanged, this);

    this.id = PANEL_ID;
    this.title.icon = workshopIcon;
    this.title.caption = 'Workshop';
    this.addClass('jp-WorkshopPanel');
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }

    this._features.changed.disconnect(this.update, this);
    this._commands.commandChanged.disconnect(this._onCommandChanged, this);
    super.dispose();
  }

  protected render(): JSX.Element {
    return (
      <WorkshopPanelComponent
        manager={this._manager}
        commands={this._commands}
        features={this._features}
      />
    );
  }

  /**
   * The author toolbar shows the record command's toggle state, so a
   * change to that command repaints the panel.
   */
  private _onCommandChanged(
    _: CommandRegistry,
    args: CommandRegistry.ICommandChangedArgs
  ): void {
    if (args.id === CommandIDs.record) {
      this.update();
    }
  }

  private _manager: IWorkshopManager;
  private _commands: CommandRegistry;
  private _features: IFeaturePolicy;
}

export namespace WorkshopPanel {
  export interface IOptions {
    manager: IWorkshopManager;
    commands: CommandRegistry;

    /** Which buttons and commands the settings leave enabled. */
    features: IFeaturePolicy;
  }
}
