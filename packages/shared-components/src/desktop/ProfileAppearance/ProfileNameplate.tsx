/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, type ReactNode } from "react";

import { type ProfileNameplateId, type ProfileNameplateValue } from "./profileCatalogue";
import styles from "./ProfileArt.module.css";

function Twinkles({ points }: { points: [number, number, number][] }): JSX.Element {
    return (
        <>
            {points.map(([x, y, radius], index) => (
                <circle
                    key={`${x}-${y}`}
                    className={styles.twinkle}
                    style={{ animationDelay: `${index * 0.4}s` }}
                    cx={x}
                    cy={y}
                    r={radius}
                    fill="#ffffff"
                />
            ))}
        </>
    );
}

function Petal({ x, y, delay, colour }: { x: number; y: number; delay: number; colour: string }): JSX.Element {
    return (
        <ellipse
            className={styles.plateFall}
            style={{ animationDelay: `${delay}s` }}
            cx={x}
            cy={y}
            rx="3"
            ry="1.8"
            fill={colour}
        />
    );
}

function Bloom({ x, y, size, colour }: { x: number; y: number; size: number; colour: string }): JSX.Element {
    return (
        <g transform={`translate(${x} ${y})`}>
            {[0, 72, 144, 216, 288].map((angle) => (
                <ellipse
                    key={angle}
                    cy={-size}
                    rx={size * 0.65}
                    ry={size}
                    fill={colour}
                    transform={`rotate(${angle})`}
                />
            ))}
            <circle r={size * 0.4} fill="#fff2b0" />
        </g>
    );
}

const SCENES: Record<ProfileNameplateId, ReactNode> = {
    moonlit: (
        <>
            <rect width="240" height="48" fill="#141a3f" />
            <circle cx="196" cy="24" r="16" fill="#e7ecff" />
            <circle cx="191" cy="19" r="3.2" fill="#c3cbef" />
            <circle cx="202" cy="29" r="4.2" fill="#c3cbef" />
            <circle cx="199" cy="15" r="1.8" fill="#c3cbef" />
            <path
                className={styles.plateDrift}
                d="M136 48c6-10 16-12 24-7 7-9 24-7 28 3 9-3 22-1 28 4Z"
                fill="#2d3773"
                opacity="0.9"
            />
            <Twinkles
                points={[
                    [150, 12, 1.2],
                    [168, 30, 0.9],
                    [226, 10, 1.3],
                    [232, 34, 0.8],
                    [128, 24, 0.9],
                ]}
            />
        </>
    ),
    blossom: (
        <>
            <rect width="240" height="48" fill="#3a1830" />
            <path
                d="M240 8C210 10 190 20 150 30M196 19c6-8 14-12 20-13"
                stroke="#6e3b2b"
                strokeWidth="2.5"
                fill="none"
            />
            <Bloom x={214} y={9} size={4.5} colour="#ff9cc2" />
            <Bloom x={186} y={22} size={5} colour="#ffc0d8" />
            <Bloom x={160} y={28} size={3.6} colour="#ff9cc2" />
            <Bloom x={230} y={24} size={3.6} colour="#ffc0d8" />
            <Petal x={140} y={4} delay={0} colour="#ffb3cf" />
            <Petal x={176} y={2} delay={1.1} colour="#ff9cc2" />
            <Petal x={208} y={4} delay={2.2} colour="#ffc0d8" />
        </>
    ),
    roses: (
        <>
            <rect width="240" height="48" fill="#1c1030" />
            <path
                d="M130 44c20-12 40-10 58-20s34-12 52-18M170 36c4-7 11-9 17-8M212 18c6 2 10 6 12 12"
                stroke="#3d6b47"
                strokeWidth="2"
                fill="none"
            />
            {[
                [186, 26, 7],
                [224, 32, 8],
                [156, 38, 5],
                [212, 10, 5],
            ].map(([x, y, size]) => (
                <g key={x} className={styles.sway} transform={`translate(${x} ${y})`}>
                    <circle r={size} fill="#7a1548" />
                    <circle r={size * 0.65} fill="#b5246c" />
                    <circle r={size * 0.32} fill="#e0559a" />
                </g>
            ))}
        </>
    ),
    nebula: (
        <>
            <rect width="240" height="48" fill="#0f0c2e" />
            <ellipse className={styles.plateDrift} cx="190" cy="26" rx="52" ry="20" fill="#7b2fd0" opacity="0.65" />
            <ellipse className={styles.plateDrift} cx="218" cy="16" rx="30" ry="14" fill="#2f8bff" opacity="0.55" />
            <ellipse cx="166" cy="34" rx="28" ry="10" fill="#e23fa8" opacity="0.4" />
            <Twinkles
                points={[
                    [146, 10, 1],
                    [176, 8, 1.3],
                    [204, 36, 1],
                    [230, 30, 1.4],
                    [132, 32, 0.8],
                ]}
            />
        </>
    ),
    aurora: (
        <>
            <rect width="240" height="48" fill="#071a26" />
            <path
                className={styles.plateDrift}
                d="M110 40C140 6 170 44 196 16S232 8 240 18V0H110Z"
                fill="#2be8a6"
                opacity="0.45"
            />
            <path
                className={styles.plateDriftReverse}
                d="M140 30C160 8 190 34 212 12S236 6 240 10V0H140Z"
                fill="#8a5cff"
                opacity="0.5"
            />
            <Twinkles
                points={[
                    [220, 38, 1],
                    [180, 40, 0.9],
                    [150, 42, 0.8],
                ]}
            />
        </>
    ),
    embers: (
        <>
            <rect width="240" height="48" fill="#230a08" />
            <path d="M120 48c26-10 50-6 70-10s36-12 50-10v20Z" fill="#7a1c0b" />
            <path d="M160 48c16-6 34-5 50-8s22-6 30-5v13Z" fill="#d6470f" />
            {[
                [150, 0],
                [176, 0.7],
                [198, 1.4],
                [216, 0.3],
                [232, 1.1],
            ].map(([x, delay]) => (
                <circle
                    key={x}
                    className={styles.plateRise}
                    style={{ animationDelay: `${delay}s` }}
                    cx={x}
                    cy="44"
                    r="1.3"
                    fill="#ffb347"
                />
            ))}
        </>
    ),
    tides: (
        <>
            <rect width="240" height="48" fill="#072440" />
            <path
                className={styles.plateDrift}
                d="M100 30c14-8 26-8 40 0s26 8 40 0 26-8 40 0 20 6 40 0v18H100Z"
                fill="#135a8f"
            />
            <path
                className={styles.plateDriftReverse}
                d="M100 38c14-7 26-7 40 0s26 7 40 0 26-7 40 0 20 5 40 0v10H100Z"
                fill="#27a0c7"
            />
        </>
    ),
    circuit: (
        <>
            <rect width="240" height="48" fill="#06151c" />
            <path
                d="M130 12h34l8 8h30l6-6h32M144 36h22l10-10h26l10 10h28M172 20v-20M206 26v22"
                stroke="#114f5c"
                strokeWidth="1.5"
                fill="none"
            />
            <path
                className={styles.platePulse}
                d="M130 12h34l8 8h30l6-6h32"
                stroke="#28f0d8"
                strokeWidth="1.5"
                fill="none"
                pathLength="100"
            />
            <path
                className={styles.platePulse}
                style={{ animationDelay: "1.2s" }}
                d="M144 36h22l10-10h26l10 10h28"
                stroke="#b45cff"
                strokeWidth="1.5"
                fill="none"
                pathLength="100"
            />
        </>
    ),
};

/** The artwork behind a name. It fades out towards the name, keeping the text on the row's own background. */
export function ProfileNameplate({ nameplate }: { nameplate: ProfileNameplateValue }): JSX.Element {
    return (
        <div className={styles.nameplate} aria-hidden="true">
            {"imageUrl" in nameplate ? (
                <img className={styles.nameplateImage} src={nameplate.imageUrl} alt="" loading="lazy" />
            ) : (
                <svg
                    className={styles.nameplateImage}
                    data-nameplate={nameplate.preset}
                    viewBox="0 0 240 48"
                    preserveAspectRatio="xMaxYMid slice"
                    focusable="false"
                >
                    {SCENES[nameplate.preset]}
                </svg>
            )}
        </div>
    );
}
