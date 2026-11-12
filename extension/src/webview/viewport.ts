// View box arithmetic. Pure.

export type Rect = { x: number; y: number; width: number; height: number };

/**
 * A view box centred on `box` with a margin around it. It is never smaller than the viewport, so a
 * small block is not blown up past 100 %, and it has the viewport's aspect ratio.
 */
export function focusBox(box: Rect, viewport: { width: number; height: number }, margin = 80): Rect {
  let width = Math.max(box.width + margin * 2, viewport.width);
  let height = Math.max(box.height + margin * 2, viewport.height);
  if (viewport.width > 0 && viewport.height > 0) {
    const ratio = viewport.width / viewport.height;
    if (width / height > ratio) height = width / ratio;
    else width = height * ratio;
  }
  return {
    x: box.x + box.width / 2 - width / 2,
    y: box.y + box.height / 2 - height / 2,
    width, height,
  };
}
