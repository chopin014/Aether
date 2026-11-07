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

/** Split text into what a reader sees as single characters, so an emoji or accented letter is never torn apart. */
function graphemes(text: string): string[] {
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
    // Gummy letters each bounce on their own, so the name is drawn letter by letter, and read out whole.
    const content =
        effect === "gummy" && typeof children === "string" ? (
            <>
                <span className={styles.visuallyHidden}>{children}</span>
                <span aria-hidden="true">
                    {graphemes(children).map((letter, index) => (
                        // A letter's place is its identity: the same letter repeats, and letters never move.
                        // oxlint-disable-next-line react/no-array-index-key
                        <span key={index} className={styles.gummyLetter} style={{ "--letter": index } as CSSProperties}>
                            {/* A lone space in an inline block collapses to nothing, so it is kept as a fixed one. */}
                            {letter === " " ? "\u00a0" : letter}
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
