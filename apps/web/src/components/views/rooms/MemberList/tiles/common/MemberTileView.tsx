/*
Copyright 2024 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { type CSSProperties, type ReactNode, type RefObject, useEffect, useRef, type JSX } from "react";
import classNames from "classnames";

import AccessibleButton from "../../../../elements/AccessibleButton";

interface Props {
    avatarJsx: JSX.Element;
    nameJsx: JSX.Element | string;
    onClick: () => void;
    onFocus: (e: React.FocusEvent) => void;
    memberIndex: number;
    memberCount: number;
    ariaLabel?: string;
    presenceJsx?: JSX.Element;
    userLabel?: React.ReactNode;
    iconJsx?: JSX.Element;
    tabIndex?: number;
    focused?: boolean;
    /**
     * Drawn behind the whole row, such as the person's nameplate. It is given the row's text, so artwork can stay
     * faint behind it.
     */
    renderBackground?: (textRef: RefObject<HTMLDivElement | null>) => ReactNode;
    /** The person is offline: the row is dimmed, as Discord does, until it is hovered or focused. */
    offline?: boolean;
    /** Hover and focus handlers, and the style they drive, so the row's artwork can move while it is active. */
    motion?: {
        style: CSSProperties;
        onPointerEnter: () => void;
        onPointerLeave: () => void;
        onFocus: () => void;
        onBlur: () => void;
    };
    /** A second line under the name, such as the person's status. */
    subtitleJsx?: JSX.Element;
}

export function MemberTileView(props: Props): JSX.Element {
    let userLabelJsx: React.ReactNode;
    if (props.userLabel) {
        userLabelJsx = <div className="mx_MemberTileView_userLabel">{props.userLabel}</div>;
    }
    const ref = useRef<HTMLDivElement | null>(null);
    const textRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        if (props.focused) {
            ref.current?.focus({ preventScroll: true, focusVisible: true });
        }
    }, [props.focused]);
    return (
        // The wrapping div is required to make the magic mouse listener work, for some reason.
        <div>
            <AccessibleButton
                ref={ref}
                className={classNames("mx_MemberTileView", { mx_MemberTileView_offline: props.offline })}
                style={props.motion?.style}
                onPointerEnter={props.motion?.onPointerEnter}
                onPointerLeave={props.motion?.onPointerLeave}
                onBlur={props.motion?.onBlur}
                onClick={props.onClick}
                onFocus={(event: React.FocusEvent) => {
                    props.motion?.onFocus();
                    props.onFocus(event);
                }}
                aria-label={props?.ariaLabel}
                tabIndex={props.tabIndex}
                role="option"
                aria-selected={props.tabIndex === 0}
                aria-posinset={props.memberIndex + 1}
                aria-setsize={props.memberCount}
            >
                {props.renderBackground?.(textRef)}
                <div aria-hidden className="mx_MemberTileView_left">
                    <div className="mx_MemberTileView_avatar">
                        {props.avatarJsx}
                        <div className="mx_MemberTileView_presence">{props.presenceJsx}</div>
                    </div>
                    {props.subtitleJsx ? (
                        <div className="mx_MemberTileView_text" ref={textRef}>
                            <div className="mx_MemberTileView_name">{props.nameJsx}</div>
                            {props.subtitleJsx}
                        </div>
                    ) : (
                        <div className="mx_MemberTileView_name" ref={textRef}>
                            {props.nameJsx}
                        </div>
                    )}
                </div>
                <div aria-hidden className="mx_MemberTileView_right">
                    {userLabelJsx}
                    {props.iconJsx}
                </div>
            </AccessibleButton>
        </div>
    );
}
