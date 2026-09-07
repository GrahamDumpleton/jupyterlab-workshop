import { isHttpUrl } from '@jupyterlab-workshop/core';
import { URLExt } from '@jupyterlab/coreutils';
import { ServerConnection } from '@jupyterlab/services';
import React from 'react';

/** Hues for the letter tiles, spread around the wheel. */
const HUES: readonly number[] = [
  210, 20, 140, 260, 40, 180, 320, 90, 240, 0, 160, 300
];

/**
 * The icon of a collection or catalog: its image when it has one, drawn
 * to fit a square box whatever its shape, and otherwise a tile with the
 * first letter of its title on a colour chosen from the title, so a
 * list with and without icons still lines up.
 */
export function SourceIcon({
  icon,
  title,
  size
}: {
  /** Resolved icon location, or undefined for the fallback tile. */
  icon?: string;
  title: string;

  /** Box size in pixels. */
  size: number;
}): JSX.Element {
  const style = { width: `${size}px`, height: `${size}px` };

  if (icon) {
    return (
      <span className="jp-WorkshopSourceIcon" style={style}>
        <img src={iconSrc(icon)} alt="" title={title} />
      </span>
    );
  }

  const letter = (title.trim().charAt(0) || '?').toUpperCase();
  const hue = HUES[hashTitle(title) % HUES.length];

  return (
    <span
      className="jp-WorkshopSourceIcon jp-mod-tile"
      role="img"
      aria-label={title}
      title={title}
      style={{
        ...style,
        fontSize: `${Math.round(size * 0.5)}px`,
        background: `hsl(${hue} 45% 45%)`
      }}
    >
      {letter}
    </span>
  );
}

/**
 * The address an icon is loaded from: a URL or data URI as given, and a
 * path under the JupyterLab root through the files endpoint.
 */
export function iconSrc(icon: string): string {
  if (isHttpUrl(icon) || /^data:/i.test(icon)) {
    return icon;
  }

  const base = ServerConnection.makeSettings().baseUrl;

  return URLExt.join(base, 'files', icon);
}

function hashTitle(title: string): number {
  let hash = 0;

  for (const char of title) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }

  return hash;
}
