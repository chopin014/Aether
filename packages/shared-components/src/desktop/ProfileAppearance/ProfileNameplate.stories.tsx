/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type JSX, useRef } from "react";
import { Avatar } from "@vector-im/compound-web";
import { type Meta, type StoryObj } from "@storybook/react-vite";

import { PROFILE_NAMEPLATES, type ProfileNameplateId, type ProfileNameStyle } from "./profileCatalogue";
import { ProfileNameplate } from "./ProfileNameplate";
import { ProfileName } from "./ProfileName";
import { useProfileMotion } from "./useProfileMotion";

// The metadata below has a named default re-export, which this rule does not recognize.
/* oxlint-disable storybook/default-exports */

/** One member-list row, laid out as the desktop member list lays it out. */
function Row({ id, nameStyle }: { id: ProfileNameplateId; nameStyle?: ProfileNameStyle }): JSX.Element {
    const motion = useProfileMotion(false);
    const text = useRef<HTMLSpanElement>(null);
    return (
        <div
            {...motion.bind}
            style={{
                ...motion.bind.style,
                position: "relative",
                display: "flex",
                alignItems: "center",
                gap: 12,
                height: 44,
                padding: "0 10px",
                borderRadius: 8,
                color: "var(--cpd-color-text-primary)",
                font: "var(--cpd-font-body-lg-medium)",
            }}
        >
            <ProfileNameplate nameplate={{ preset: id }} live={motion.live} textRef={text} />
            <span style={{ position: "relative", display: "flex" }}>
                <Avatar id={id} name={id} size="32px" type="round" />
            </span>
            <span ref={text} style={{ position: "relative" }}>
                <ProfileName nameStyle={nameStyle}>{id}</ProfileName>
            </span>
        </div>
    );
}

function Gallery(): JSX.Element {
    return (
        <div style={{ display: "grid", gap: 4, width: 240, padding: 12, background: "var(--cpd-color-bg-canvas-default)" }}>
            {PROFILE_NAMEPLATES.map((id) => (
                <Row key={id} id={id} />
            ))}
        </div>
    );
}

const meta = {
    title: "Desktop/Profile/Nameplates",
    component: Gallery,
} satisfies Meta<typeof Gallery>;
export { meta as default };
type Story = StoryObj<typeof meta>;

/** Every built-in nameplate in a member list. Point at a row to see it move. */
export const AllNameplates: Story = {};
