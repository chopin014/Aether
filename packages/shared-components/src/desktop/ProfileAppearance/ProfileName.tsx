/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type CSSProperties, type JSX, type ReactNode } from "react";
import classNames from "classnames";

import { type ProfileNameStyle } from "./profileCatalogue";
import styles from "./ProfileArt.module.css";

interface ProfileNameProps {
    nameStyle?: ProfileNameStyle;
    className?: string;
    children: ReactNode;
}

/**
 * Characters from scripts whose letters stand alone, plus punctuation, symbols, emoji and combining marks. Letters of
 * any other script (Arabic, Syriac, the Indic scripts and more) change shape with their neighbours, and drawing them
 * one by one would break those joins.
 */
const SEPARATE_LETTERS =
    /^[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Armenian}\p{Script=Georgian}\p{Script=Hebrew}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Common}\p{Script=Inherited}]*$/u;

/**
 * Split a name into the pieces that bounce on their own: single characters as a reader sees them, so an emoji or
 * accented letter is never torn apart, or whole words where letters join up, so the word keeps its shape.
 */
function gummyPieces(text: string): string[] {
    if (!SEPARATE_LETTERS.test(text)) return text.split(/(\s+)/).filter(Boolean);
    if (typeof Intl.Segmenter !== "function") return [...text];
    return [...new Intl.Segmenter().segment(text)].map((part) => part.segment);
}

/** A display name in the person's chosen font and colours. Without a style it is plain inherited text. */
export function ProfileName({ nameStyle, className, children }: ProfileNameProps): JSX.Element {
    if (!nameStyle) return <span className={className}>{children}</span>;
    const start = nameStyle.colour;
    const effect = start ? nameStyle.effect : "none";
    const style = {
        ...(start ? { "--name-start": start } : {}),
        ...(start ? { "--name-end": nameStyle.colourEnd ?? start } : {}),
    } as CSSProperties;
    // Gummy letters (or words) each bounce on their own, so the name is drawn piece by piece, and read out whole.
    const content =
        effect === "gummy" && typeof children === "string" ? (
            <>
                <span className={styles.visuallyHidden}>{children}</span>
                <span aria-hidden="true">
                    {gummyPieces(children).map((letter, index) => (
                        // A letter's place is its identity: the same letter repeats, and letters never move.
                        // oxlint-disable-next-line react/no-array-index-key
                        <span key={index} className={styles.gummyLetter} style={{ "--letter": index } as CSSProperties}>
                            {/* Spaces alone in an inline block collapse to nothing, so they are kept as fixed ones. */}
                            {/^\s+$/.test(letter) ? "\u00a0" : letter}
                        </span>
                    ))}
                </span>
            </>
        ) : (
            children
        );
    return (
        <span
            className={classNames(styles.name, className)}
            data-font={nameStyle.font}
            data-name-effect={effect}
            data-coloured={start ? "true" : undefined}
            style={style}
        >
            {content}
        </span>
    );
}
