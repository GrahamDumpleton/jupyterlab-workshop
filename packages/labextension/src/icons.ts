import { LabIcon } from '@jupyterlab/ui-components';

import infoSvg from '../style/icons/info.svg';
import newWorkshopSvg from '../style/icons/workshop-new.svg';
import workshopSvg from '../style/icons/workshop.svg';

/**
 * Icon for the workshop panel, the workshop browser and the launcher
 * card: a graduation cap, taken from the Educates Training Platform's
 * logo without its surrounding heptagon.
 */
export const workshopIcon = new LabIcon({
  name: 'jupyterlab-workshop:cap',
  svgstr: workshopSvg
});

/**
 * The cap with a plus badge in its lower corner, for commands that create
 * a new workshop.
 */
export const newWorkshopIcon = new LabIcon({
  name: 'jupyterlab-workshop:cap-new',
  svgstr: newWorkshopSvg
});

/**
 * The About button in the panel header: a filled circle with an i, drawn
 * at the same weight as JupyterLab's toolbar icons, since the info icon
 * JupyterLab ships is a thin outline meant for the status bar.
 */
export const infoIcon = new LabIcon({
  name: 'jupyterlab-workshop:info',
  svgstr: infoSvg
});
