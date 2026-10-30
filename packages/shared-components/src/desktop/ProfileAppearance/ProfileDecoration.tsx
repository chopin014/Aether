/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, type ReactNode, useId } from "react";

import { type ProfileDecorationId } from "./profileCatalogue";
import styles from "./ProfileArt.module.css";

/** Evenly spaced angles round the avatar, in degrees. */
function around(count: number, from = 0, to = 360): number[] {
    const step = (to - from) / count;
    return Array.from({ length: count }, (_, index) => from + step * index);
}

function delay(seconds: number): React.CSSProperties {
    return { animationDelay: `${seconds}s` };
}

function Flower({
    x,
    y,
    size,
    colour,
    core,
}: {
    x: number;
    y: number;
    size: number;
    colour: string;
    core: string;
}): JSX.Element {
    return (
        <g transform={`translate(${x} ${y})`}>
            {around(5).map((angle) => (
                <ellipse
                    key={angle}
                    cy={-size}
                    rx={size * 0.62}
                    ry={size}
                    fill={colour}
                    transform={`rotate(${angle})`}
                />
            ))}
            <circle r={size * 0.45} fill={core} />
        </g>
    );
}

function Rose({ x, y, size }: { x: number; y: number; size: number }): JSX.Element {
    return (
        <g transform={`translate(${x} ${y})`}>
            <circle r={size} fill="#8e1138" />
            <path d={`M${-size * 0.8} 0a${size * 0.8} ${size * 0.8} 0 0 1 ${size * 1.6} 0`} fill="#c2185b" />
            <circle r={size * 0.55} fill="#e63e6d" />
            <circle r={size * 0.25} cx={size * 0.1} fill="#8e1138" />
        </g>
    );
}

const ART: Record<ProfileDecorationId, (id: string) => ReactNode> = {
    "neon-ring": (id) => (
        <>
            <defs>
                <linearGradient id={`${id}-neon`} x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stopColor="#ff2fd6" />
                    <stop offset="0.5" stopColor="#7b5cff" />
                    <stop offset="1" stopColor="#23e6ff" />
                </linearGradient>
            </defs>
            <g className={styles.spinSlow}>
                <circle cx="60" cy="60" r="54" fill="none" stroke={`url(#${id}-neon)`} strokeWidth="4" />
                <circle
                    cx="60"
                    cy="60"
                    r="57.5"
                    fill="none"
                    stroke={`url(#${id}-neon)`}
                    strokeWidth="1.5"
                    strokeDasharray="42 26"
                    opacity="0.85"
                />
            </g>
        </>
    ),
    "flame-crown": (id) => {
        // Flames climb the ring: low at the base, tallest at the crown, and every tip bends up as fire does.
        const tongues = around(22).map((angle, index) => {
            const upness = (1 + Math.cos((angle * Math.PI) / 180)) / 2;
            const height = (index % 2 ? 7 : 11) + upness * (index % 2 ? 10 : 20);
            const lean = Math.sin((angle * Math.PI) / 180) * -5 * (1 - upness);
            return { angle, height, lean, index };
        });
        const flame = (height: number, lean: number, width: number): string =>
            `M${-width} -49C${-width - 2} ${-49 - height * 0.45} ${lean - 2} ${-49 - height * 0.6} ${lean} ${-49 - height}C${lean + 1.5} ${-49 - height * 0.6} ${width + 2} ${-49 - height * 0.4} ${width} -49Z`;
        return (
            <>
                <defs>
                    <linearGradient id={`${id}-outer`} x1="0" y1="1" x2="0" y2="0">
                        <stop offset="0" stopColor="#ff5a12" />
                        <stop offset="0.6" stopColor="#e3201b" />
                        <stop offset="1" stopColor="#7d0b24" />
                    </linearGradient>
                    <linearGradient id={`${id}-inner`} x1="0" y1="1" x2="0" y2="0">
                        <stop offset="0" stopColor="#fff3b0" />
                        <stop offset="1" stopColor="#ff9c1f" />
                    </linearGradient>
                </defs>
                {tongues.map(({ angle, height, lean, index }) => (
                    <g key={angle} transform={`translate(60 60) rotate(${angle})`}>
                        <path
                            className={styles.flicker}
                            style={delay(index * 0.13)}
                            d={flame(height, lean, 6)}
                            fill={`url(#${id}-outer)`}
                        />
                    </g>
                ))}
                {tongues
                    .filter(({ index }) => index % 2 === 0)
                    .map(({ angle, height, lean, index }) => (
                        <g key={angle} transform={`translate(60 60) rotate(${angle})`}>
                            <path
                                className={styles.flicker}
                                style={delay(index * 0.09 + 0.3)}
                                d={flame(height * 0.55, lean * 0.5, 3.5)}
                                fill={`url(#${id}-inner)`}
                            />
                        </g>
                    ))}
                <circle cx="60" cy="60" r="50.5" fill="none" stroke="#ffb347" strokeWidth="2" />
            </>
        );
    },
    "sakura-wreath": () => (
        <>
            <circle cx="60" cy="60" r="53" fill="none" stroke="#7a4a3a" strokeWidth="2" strokeDasharray="30 6 18 4" />
            {around(9).map((angle, index) => {
                const radians = (angle * Math.PI) / 180;
                return (
                    <g key={angle} className={styles.sway} style={delay(index * 0.3)}>
                        <Flower
                            x={60 + Math.sin(radians) * 53}
                            y={60 - Math.cos(radians) * 53}
                            size={index % 3 === 0 ? 5.2 : 3.8}
                            colour={index % 2 ? "#ffc1d9" : "#ff97bd"}
                            core="#fff1a8"
                        />
                    </g>
                );
            })}
        </>
    ),
    "frost-crown": (id) => (
        <>
            <defs>
                <linearGradient id={`${id}-ice`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor="#ffffff" />
                    <stop offset="1" stopColor="#6fd0ff" />
                </linearGradient>
            </defs>
            <circle cx="60" cy="60" r="52" fill="none" stroke="#a8e4ff" strokeWidth="2.5" />
            {around(13, -78, 78).map((angle, index) => (
                <path
                    key={angle}
                    d={index % 2 ? "M-4 -50L0 -62L4 -50Z" : "M-5 -50L0 -71L5 -50Z"}
                    fill={`url(#${id}-ice)`}
                    transform={`translate(60 60) rotate(${angle + 6})`}
                />
            ))}
            {[
                [14, 26],
                [104, 20],
                [112, 76],
                [8, 80],
            ].map(([x, y], index) => (
                <path
                    key={x}
                    className={styles.twinkle}
                    style={delay(index * 0.5)}
                    d={`M${x} ${y - 6}L${x + 1.5} ${y - 1.5}L${x + 6} ${y}L${x + 1.5} ${y + 1.5}L${x} ${y + 6}L${x - 1.5} ${y + 1.5}L${x - 6} ${y}L${x - 1.5} ${y - 1.5}Z`}
                    fill="#ffffff"
                />
            ))}
        </>
    ),
    "halo": () => (
        <g className={styles.bob}>
            <ellipse cx="60" cy="9" rx="28" ry="7" fill="none" stroke="#ffe27a" strokeWidth="4" />
            <ellipse cx="60" cy="9" rx="28" ry="7" fill="none" stroke="#fff8d8" strokeWidth="1.2" />
        </g>
    ),
    "orbit": () => (
        <>
            <circle cx="60" cy="60" r="55" fill="none" stroke="#9ad7ff" strokeOpacity="0.5" strokeWidth="1" />
            <circle cx="60" cy="60" r="51" fill="none" stroke="#c9a7ff" strokeOpacity="0.4" strokeWidth="1" />
            <g className={styles.spinFast}>
                <circle cx="60" cy="5" r="4" fill="#9ad7ff" />
            </g>
            <g className={styles.spinSlow}>
                <circle cx="60" cy="9" r="3" fill="#ff9ae0" />
                <circle cx="60" cy="111" r="2.4" fill="#ffe27a" />
            </g>
        </>
    ),
    "thorn-rose": () => (
        <>
            <circle cx="60" cy="60" r="53" fill="none" stroke="#2f5d3a" strokeWidth="3" />
            {around(16).map((angle) => (
                <path
                    key={angle}
                    d="M-2 -52L0 -59L2 -52Z"
                    fill="#1f4029"
                    transform={`translate(60 60) rotate(${angle})`}
                />
            ))}
            <g className={styles.sway}>
                <Rose x={22} y={20} size={9} />
                <Rose x={103} y={32} size={6.5} />
                <Rose x={94} y={103} size={8} />
                <Rose x={11} y={80} size={5.5} />
            </g>
        </>
    ),
    "cat-ears": () => (
        <>
            <g className={styles.twitch}>
                <path d="M15 34L12 2L44 16Z" fill="#2c2b33" stroke="#e8e6ee" strokeWidth="2" strokeLinejoin="round" />
                <path d="M20 26L18 11L35 18Z" fill="#ff9bbd" />
            </g>
            <g className={styles.twitch} style={delay(0.4)}>
                <path d="M105 34L108 2L76 16Z" fill="#2c2b33" stroke="#e8e6ee" strokeWidth="2" strokeLinejoin="round" />
                <path d="M100 26L102 11L85 18Z" fill="#ff9bbd" />
            </g>
        </>
    ),
    "galaxy": (id) => (
        <>
            <defs>
                <linearGradient id={`${id}-galaxy`} x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stopColor="#3b1c8f" />
                    <stop offset="0.5" stopColor="#c04dff" />
                    <stop offset="1" stopColor="#2fb7ff" />
                </linearGradient>
            </defs>
            <g className={styles.spinSlow}>
                <circle
                    cx="60"
                    cy="60"
                    r="54"
                    fill="none"
                    stroke={`url(#${id}-galaxy)`}
                    strokeWidth="7"
                    opacity="0.9"
                />
                {around(14).map((angle, index) => (
                    <circle
                        key={angle}
                        className={styles.twinkle}
                        style={delay(index * 0.25)}
                        r={index % 3 === 0 ? 1.8 : 1}
                        cy={-54}
                        fill="#ffffff"
                        transform={`translate(60 60) rotate(${angle})`}
                    />
                ))}
            </g>
        </>
    ),
    "glitch": () => (
        <>
            <g className={styles.spinStep}>
                <circle
                    cx="60"
                    cy="60"
                    r="54"
                    fill="none"
                    stroke="#21f5e1"
                    strokeWidth="3.5"
                    strokeDasharray="34 12 8 12"
                />
            </g>
            <g className={styles.spinStepReverse}>
                <circle
                    cx="60"
                    cy="60"
                    r="56"
                    fill="none"
                    stroke="#ff2b7e"
                    strokeWidth="2"
                    strokeDasharray="18 22 44 16"
                />
            </g>
        </>
    ),
};

/** A built-in animated frame. Its parent decides the size; the artwork reaches beyond the avatar it surrounds. */
export function ProfileDecoration({ id }: { id: ProfileDecorationId }): JSX.Element {
    const uid = useId().replaceAll(":", "");
    return (
        <svg
            className={styles.decoration}
            data-decoration={id}
            viewBox="0 0 120 120"
            aria-hidden="true"
            focusable="false"
        >
            {ART[id](uid)}
        </svg>
    );
}
