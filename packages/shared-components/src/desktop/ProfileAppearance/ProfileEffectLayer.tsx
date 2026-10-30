/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type CSSProperties, type JSX, useMemo } from "react";

import { type ProfileEffectId } from "./profileCatalogue";
import styles from "./ProfileArt.module.css";

const PARTICLES: Record<Exclude<ProfileEffectId, "aurora">, number> = {
    snow: 26,
    sakura: 18,
    stars: 26,
    embers: 22,
    fireflies: 14,
    rain: 30,
    confetti: 24,
};

/** A small repeatable random sequence, so a person's card looks the same each time it opens. */
function seededRandom(seed: string): () => number {
    let state = 0;
    for (const char of seed) state = (Math.imul(state, 31) + (char.codePointAt(0) ?? 0)) | 0;
    return () => {
        state = (state + 0x6d2b79f5) | 0;
        let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
        mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
        return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    };
}

interface ProfileEffectLayerProps {
    id: ProfileEffectId;
    /** Varies the particle layout from person to person. */
    seed: string;
}

/** A built-in animation over a whole card. It never takes pointer input, so everything beneath stays usable. */
export function ProfileEffectLayer({ id, seed }: ProfileEffectLayerProps): JSX.Element {
    const particles = useMemo(() => {
        if (id === "aurora") return [];
        const random = seededRandom(`${id}${seed}`);
        return Array.from({ length: PARTICLES[id] }, (_, particle) => ({
            particle,
            style: {
                "--x": `${random() * 100}%`,
                "--y": `${random() * 100}%`,
                "--size": random(),
                "--drift": `${(random() - 0.5) * 80}px`,
                "--duration": `${4 + random() * 6}s`,
                "--delay": `${random() * -10}s`,
                "--hue": `${Math.floor(random() * 360)}deg`,
            } as CSSProperties,
        }));
    }, [id, seed]);

    return (
        <div className={styles.effect} data-effect={id} aria-hidden="true">
            {id === "aurora" ? (
                <>
                    <span className={styles.auroraBand} />
                    <span className={styles.auroraBand} />
                    <span className={styles.auroraBand} />
                </>
            ) : (
                particles.map(({ particle, style }) => (
                    <span key={particle} className={styles.particle} style={style} />
                ))
            )}
        </div>
    );
}
