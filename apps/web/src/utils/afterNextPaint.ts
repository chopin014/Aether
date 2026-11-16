/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

/** {@link afterNextPaint} runs its callback by then even if no frame is painted, as in a hidden window. */
export const AFTER_PAINT_DEADLINE_MS = 100;

/**
 * Runs heavy work once what the user just asked for has been painted, so that it shows first. The next frame can come
 * before an update made now is rendered (React renders in a task of its own), so this waits for the frame after it.
 *
 * @param work - What to run, once.
 * @returns A function that cancels the work if it has not run yet.
 */
export function afterNextPaint(work: () => void): () => void {
    let done = false;
    let frame: number;
    let afterFrame: ReturnType<typeof setTimeout> | undefined;
    const run = (): void => {
        if (done) return;
        cancel();
        work();
    };
    // A task queued from a frame callback runs after that frame has been painted.
    frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
            afterFrame = setTimeout(run, 0);
        });
    });
    const deadline = setTimeout(run, AFTER_PAINT_DEADLINE_MS);
    const cancel = (): void => {
        done = true;
        cancelAnimationFrame(frame);
        clearTimeout(afterFrame);
        clearTimeout(deadline);
    };
    return cancel;
}
