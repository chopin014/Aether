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

/** A display name in the person's chosen font and colours. Without a style it is plain inherited text. */
export function ProfileName({ nameStyle, className, children }: ProfileNameProps): JSX.Element {
    if (!nameStyle) return <span className={className}>{children}</span>;
    const start = nameStyle.colour;
    const style = {
        ...(start ? { "--name-start": start } : {}),
        ...(start ? { "--name-end": nameStyle.colourEnd ?? start } : {}),
    } as CSSProperties;
    return (
        <span
            className={classNames(styles.name, className)}
            data-font={nameStyle.font}
            data-name-effect={start ? nameStyle.effect : "none"}
            data-coloured={start ? "true" : undefined}
            style={style}
        >
            {children}
        </span>
    );
}
