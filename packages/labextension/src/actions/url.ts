import { JupyterFrontEnd } from '@jupyterlab/application';
import { MainAreaWidget, WidgetTracker } from '@jupyterlab/apputils';
import { Widget } from '@lumino/widgets';

import { LayoutManager } from '../layout';
import {
  IActionImplementation,
  IActionRequest,
  IActionResult
} from '../tokens';
import { requireOption } from './registry';

/** Prefix of the widget id of every URL pane. */
const PANE_ID_PREFIX = 'jupyterlab-workshop-url-';

/** The only URLs a pane shows or a tab is opened on. */
const WEB_URL = /^https?:/i;

/**
 * The content of a URL pane: an iframe showing a page from elsewhere.
 *
 * Loading replaces the iframe element rather than changing its address,
 * so the page starts from a fresh browsing context even when the URL is
 * the one already shown; an application in the page starts over instead
 * of resuming from its own cache. The frame carries no sandbox: a page
 * from another origin is isolated by the browser regardless, and a
 * sandbox would only stop it using storage, cookies and popups.
 */
export class UrlPaneContent extends Widget {
  constructor(name: string) {
    super();

    this.addClass('jp-WorkshopUrlPane');
    this._name = name;
  }

  /** The pane name the workshop uses for this pane. */
  get name(): string {
    return this._name;
  }

  /** The URL last loaded into the pane. */
  get url(): string {
    return this._url;
  }

  /** Show a page, replacing whatever the pane showed before. */
  load(url: string): void {
    this._frame?.remove();

    const frame = document.createElement('iframe');

    frame.className = 'jp-WorkshopUrlPane-frame';
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.title = this._name;
    frame.src = url;
    this.node.appendChild(frame);

    this._frame = frame;
    this._url = url;
  }

  private _name: string;
  private _url = '';
  private _frame: HTMLIFrameElement | null = null;
}

/** A URL pane as it sits in the main area. */
export type UrlPane = MainAreaWidget<UrlPaneContent>;

/**
 * The URL panes open in the main area, by name.
 *
 * Panes are tracked so that JupyterLab's layout restorer can bring them
 * back after the browser page reloads, at the URL each was last sent.
 */
export class UrlPanes {
  constructor(options: UrlPanes.IOptions) {
    this._app = options.app;
    this._layouts = options.layouts;
  }

  /** The tracker the layout restorer restores panes from. */
  readonly tracker: WidgetTracker<UrlPane> = new WidgetTracker<UrlPane>({
    namespace: 'jupyterlab-workshop-url'
  });

  /** The open pane of that name, if any. */
  get(name: string): UrlPane | undefined {
    const pane = this._panes.get(name);

    return pane && !pane.isDisposed ? pane : undefined;
  }

  /** The names of the open panes. */
  names(): string[] {
    return [...this._panes.keys()].filter(name => this.get(name));
  }

  /**
   * Show a page in the named pane, creating the pane when there is none
   * and placing it where `area` says, or reloading the existing pane and
   * bringing it forward.
   */
  async open(
    name: string,
    url: string,
    options: { area?: string; label?: string } = {}
  ): Promise<UrlPane> {
    const existing = this.get(name);

    if (existing) {
      existing.content.load(url);
      existing.title.caption = url;

      if (options.label) {
        existing.title.label = options.label;
      }

      await this._layouts.place(existing, 'document', options.area, {
        existed: true,
        placed: true
      });
      await this.tracker.save(existing);

      return existing;
    }

    const pane = this.create(name, url, options.label);

    this._app.shell.add(pane, 'main');
    await this._layouts.place(pane, 'document', options.area, {
      existed: false,
      placed: false
    });

    return pane;
  }

  /**
   * Build a pane showing a page and start tracking it, without adding it
   * to the shell. The restorer uses this and then places the pane where
   * it was.
   */
  create(name: string, url: string, label?: string): UrlPane {
    const content = new UrlPaneContent(name);

    content.load(url);

    const pane = new MainAreaWidget<UrlPaneContent>({ content });

    pane.id = PANE_ID_PREFIX + name;
    pane.title.label = label || name;
    pane.title.caption = url;
    pane.title.closable = true;
    pane.addClass('jp-WorkshopUrlPane-widget');

    this._panes.set(name, pane);
    pane.disposed.connect(() => {
      if (this._panes.get(name) === pane) {
        this._panes.delete(name);
      }
    });
    void this.tracker.add(pane);

    return pane;
  }

  /** Close every pane, as when the workshop closes or restarts. */
  closeAll(): void {
    for (const pane of this._panes.values()) {
      pane.dispose();
    }

    this._panes.clear();
  }

  private _app: JupyterFrontEnd;
  private _layouts: LayoutManager;
  private _panes = new Map<string, UrlPane>();
}

export namespace UrlPanes {
  export interface IOptions {
    app: JupyterFrontEnd;
    layouts: LayoutManager;
  }
}

/**
 * The `url-open` action: open a web page in a new browser tab, or in a
 * named pane in the main area.
 */
export class UrlOpenAction implements IActionImplementation {
  readonly type = 'url-open';

  constructor(panes: UrlPanes) {
    this._panes = panes;
  }

  describe(request: IActionRequest): string {
    const url = request.options.url || '(no url)';
    const pane = request.options.pane;

    return pane ? `Open ${url} in pane ${pane}` : `Open ${url} in a new tab`;
  }

  async run(request: IActionRequest): Promise<IActionResult> {
    // A URL built from a variable that has no value yet would be missing
    // its host or port, so wait for the value rather than open it.
    if (request.unset && request.unset.length > 0) {
      const names = request.unset.map(name => `"${name}"`).join(', ');

      return {
        status: 'error',
        message: `The url-open action needs a value for ${names} first`
      };
    }

    const url = requireOption(request, 'url');

    if (url.includes('{{')) {
      return {
        status: 'error',
        message: `The URL "${url}" refers to a variable the workshop does not declare`
      };
    }

    if (!WEB_URL.test(url)) {
      return {
        status: 'error',
        message: `The url-open action needs an http or https URL, not "${url}"`
      };
    }

    // A page served over https cannot frame an http page; the browser
    // blocks it silently, so a new tab is the only way to show it.
    const pane = request.options.pane;
    const blocked =
      /^http:/i.test(url) && window.location.protocol === 'https:';

    if (!pane || blocked) {
      return openTab(url);
    }

    await this._panes.open(pane, url, {
      area: request.options.area,
      label: request.options.label
    });

    return { status: 'ok' };
  }

  private _panes: UrlPanes;
}

/**
 * Open a URL in a new browser tab. The browser allows this only while a
 * click is being handled, so a run from a chain or a cascade is refused
 * and the refusal is reported rather than lost.
 */
function openTab(url: string): IActionResult {
  const opened = window.open(url, '_blank');

  if (!opened) {
    return {
      status: 'error',
      message:
        'The browser did not allow a new tab; url-open without a pane needs a click'
    };
  }

  // The new tab starts on a blank page of this origin, so its link back
  // to this window can be cut before the page loads.
  try {
    opened.opener = null;
  } catch {
    // Already another origin; nothing to cut.
  }

  return { status: 'ok' };
}
