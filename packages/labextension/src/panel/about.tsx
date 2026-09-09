import { Dialog, showDialog } from '@jupyterlab/apputils';
import { Widget } from '@lumino/widgets';

import { IWorkshopManager } from '../tokens';
import { PLATFORM_LABELS } from './components';

/**
 * Show the About dialog for the open workshop: its description and the
 * details the manifest gives, with the website and problem-report links
 * when it has them.
 */
export async function showAboutDialog(
  manager: IWorkshopManager
): Promise<void> {
  const workshop = manager.workshop;

  if (!workshop) {
    return;
  }

  await showDialog({
    title: workshop.manifest.title,
    body: new AboutBody(workshop.manifest),
    buttons: [Dialog.okButton({ label: 'Close' })]
  });
}

/** The manifest fields the dialog shows. */
interface IAboutDetails {
  version?: string;
  description?: string;
  duration?: string;
  authors: string[];
  tags: string[];
  platforms: string[];
  homepage?: string;
  issues?: string;
}

/**
 * The dialog body: the description, then a list of the details that are
 * set, each link opening in a new tab.
 */
class AboutBody extends Widget {
  constructor(manifest: IAboutDetails) {
    super();

    this.addClass('jp-WorkshopAbout');

    if (manifest.description) {
      const description = document.createElement('p');

      description.className = 'jp-WorkshopAbout-description';
      description.textContent = manifest.description;
      this.node.appendChild(description);
    }

    const details = document.createElement('dl');

    details.className = 'jp-WorkshopAbout-details';
    this.node.appendChild(details);

    const addRow = (label: string, value: HTMLElement | string): void => {
      const term = document.createElement('dt');
      const definition = document.createElement('dd');

      term.textContent = label;

      if (typeof value === 'string') {
        definition.textContent = value;
      } else {
        definition.appendChild(value);
      }

      details.appendChild(term);
      details.appendChild(definition);
    };

    const link = (url: string): HTMLAnchorElement => {
      const anchor = document.createElement('a');

      anchor.href = url;
      anchor.target = '_blank';
      anchor.rel = 'noreferrer';
      anchor.textContent = url;

      return anchor;
    };

    if (manifest.version) {
      addRow('Version', manifest.version);
    }

    if (manifest.authors.length > 0) {
      addRow('Authors', manifest.authors.join(', '));
    }

    if (manifest.duration) {
      addRow('Duration', manifest.duration);
    }

    if (manifest.platforms.length > 0) {
      addRow(
        'Platforms',
        manifest.platforms.map(name => PLATFORM_LABELS[name] ?? name).join(', ')
      );
    }

    if (manifest.tags.length > 0) {
      addRow('Tags', manifest.tags.join(', '));
    }

    if (manifest.homepage) {
      addRow('Website', link(manifest.homepage));
    }

    if (manifest.issues) {
      addRow('Report a problem', link(manifest.issues));
    }

    // A manifest with nothing beyond its title still gets a dialog that
    // says so, rather than an empty one.
    if (!details.hasChildNodes()) {
      const note = document.createElement('p');

      note.className = 'jp-WorkshopAbout-empty';
      note.textContent = 'This workshop gives no further details about itself.';
      this.node.replaceChild(note, details);
    }
  }
}
