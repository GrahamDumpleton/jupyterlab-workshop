import { ReactWidget } from '@jupyterlab/ui-components';
import { CommandRegistry } from '@lumino/commands';
import React from 'react';

import { workshopIcon } from '../icons';
import { IWorkshopManager } from '../tokens';
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

    this.id = PANEL_ID;
    this.title.icon = workshopIcon;
    this.title.caption = 'Workshop';
    this.addClass('jp-WorkshopPanel');
  }

  protected render(): JSX.Element {
    return (
      <WorkshopPanelComponent
        manager={this._manager}
        commands={this._commands}
      />
    );
  }

  private _manager: IWorkshopManager;
  private _commands: CommandRegistry;
}

export namespace WorkshopPanel {
  export interface IOptions {
    manager: IWorkshopManager;
    commands: CommandRegistry;
  }
}
