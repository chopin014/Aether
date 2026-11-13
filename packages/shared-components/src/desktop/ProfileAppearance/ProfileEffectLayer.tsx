/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, useMemo } from "react";

import { ArtCanvas } from "./art/ArtCanvas";
import { effectScene } from "./art/effectScenes";
import { type ProfileEffectId } from "./profileCatalogue";
import styles from "./ProfileArt.module.css";

/** Discord waits this long after a card opens before its effect starts, so the card lands first. */
const INTRO_DELAY_S = 0.5;
/** Effects are soft light and particles, which need no more pixels than this even across a whole dialog. */
const MAX_EFFECT_PIXELS = 1_500_000;

interface ProfileEffectLayerProps {
    id: ProfileEffectId;
    /** Varies the layout from person to person while keeping each person's the same every time. */
    seed: string;
    /** The effect moves. Still, it shows one composed frame. */
    live?: boolean;
    /** The pointer is on the card, so the effect steps back to let its content read. */
    dimmed?: boolean;
    /** Frames per second, lowered where many effects run at once. */
    fps?: number;
}

/** An animation over a whole card. It never takes pointer input, so everything beneath stays usable. */
export function ProfileEffectLayer({
    id,
    seed,
    live = true,
    dimmed = false,
    fps,
}: ProfileEffectLayerProps): JSX.Element {
    const scene = useMemo(() => effectScene(id, seed), [id, seed]);
    return (
        <div className={styles.effect} data-effect={id} data-dimmed={dimmed} aria-hidden="true">
            <ArtCanvas
                className={styles.effectCanvas}
                scene={scene}
                live={live}
                fps={fps}
                from={-INTRO_DELAY_S}
                maxPixels={MAX_EFFECT_PIXELS}
            />
        </div>
    );
}
