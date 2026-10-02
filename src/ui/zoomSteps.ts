/**
 * Zoom steps, in screen (device) pixels per game pixel. At whole numbers and at simple fractions every game pixel
 * covers the same number of screen pixels, so tiles stay sharp; the in-between amounts a free zoom reaches (96%,
 * 1.37×…) blur them through the texture filtering.
 */
export const ZOOM_STEPS = [1 / 32, 1 / 16, 1 / 8, 3 / 16, 1 / 4, 3 / 8, 1 / 2, 3 / 4, 1, 2, 3, 4, 5, 6, 8];

const EPS = 1e-6;

/** The largest step not above `zoom` (the smallest step when `zoom` is below them all). */
export function stepAtOrBelow(zoom: number): number {
  let out = ZOOM_STEPS[0];
  for (const s of ZOOM_STEPS) if (s <= zoom + EPS) out = s;
  return out;
}

/** The step `n` steps in (n > 0) or out (n < 0) from `zoom` (from the step at or below it, when between steps). */
export function stepZoom(zoom: number, n: number): number {
  const at = ZOOM_STEPS.indexOf(stepAtOrBelow(zoom));
  // Between steps, one step in is the next step up; one step out is the step just below.
  const between = Math.abs(ZOOM_STEPS[at] - zoom) > EPS;
  const from = between && n < 0 ? at + 1 : at;
  return ZOOM_STEPS[Math.min(Math.max(from + n, 0), ZOOM_STEPS.length - 1)];
}

/**
 * Wheel movement adds up until it makes a whole step: one notch of a mouse wheel (100) is a step at normal speed;
 * a touchpad's many small movements add up the same way.
 */
export class WheelSteps {
  private sum = 0;
  private last = 0;
  /** The steps (+ in, - out) this wheel movement completes. */
  take(deltaY: number, speed: number, now: number): number {
    if (now - this.last > 400 || (this.sum && Math.sign(-deltaY) !== Math.sign(this.sum))) this.sum = 0;
    this.last = now;
    this.sum += -deltaY * speed;
    const per = 100;
    const n = Math.trunc(this.sum / per);
    // A wheel notch smaller than a step (some mice report 50s) still moves at least one step on its own.
    if (!n && Math.abs(deltaY) >= 50 && Math.abs(this.sum) >= 50) {
      const one = Math.sign(this.sum);
      this.sum = 0;
      return one;
    }
    // One step per event at most: accelerated scrolling (300+ per event) would otherwise skip steps.
    this.sum = n ? 0 : this.sum;
    return Math.sign(n);
  }
}
