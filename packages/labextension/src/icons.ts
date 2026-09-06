import { LabIcon } from '@jupyterlab/ui-components';

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
