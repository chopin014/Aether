/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Avatar, TooltipProvider } from "@vector-im/compound-web";

import "@vector-im/compound-design-tokens/assets/web/css/compound-design-tokens.css";
import "@vector-im/compound-web/dist/style.css";
// Import source views so the layout test uses current CSS modules without a separate package build.
/* oxlint-disable no-restricted-imports */
import { ProfileNameplate } from "../../../../../../../packages/shared-components/src/desktop/ProfileAppearance/ProfileNameplate";
import { ProfileDecoration } from "../../../../../../../packages/shared-components/src/desktop/ProfileAppearance/ProfileDecoration";
import { PresenceGlyph } from "../../../../../../../packages/shared-components/src/presence/PresenceGlyph";
/* oxlint-enable no-restricted-imports */
import desktopShellCss from "../../../../../res/css/structures/_DesktopShell.pcss?raw";
import memberTileCss from "../../../../../res/css/views/rooms/_MemberTileView.pcss?raw";
import memberListCss from "../../../../../res/css/views/rooms/_MemberListView.pcss?raw";
import presenceCss from "../../../../../res/css/views/rooms/_PresenceIconView.pcss?raw";
import { MemberTileView } from "./tiles/common/MemberTileView";

// The row's button reaches app modules that need Node globals this browser runner lacks; a plain element will do.
vi.mock("../../elements/AccessibleButton", () => ({
    default: (props: React.ComponentProps<"div">) => <div {...props} />,
}));

describe("Desktop member row", () => {
    let container: HTMLDivElement;
    let stylesheet: HTMLStyleElement;
    let root: Root;

    beforeEach(() => {
        stylesheet = document.createElement("style");
        stylesheet.textContent = `* { box-sizing: border-box; } ${memberTileCss} ${memberListCss} ${presenceCss} ${desktopShellCss}`;
        document.head.appendChild(stylesheet);
        document.body.classList.add("mx_DesktopShell", "cpd-theme-dark");
        container = document.createElement("div");
        container.className = "mx_MatrixChat_wrapper mx_MatrixChat_desktopShell";
        container.style.width = "264px";
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        flushSync(() => root.unmount());
        container.remove();
        stylesheet.remove();
        document.body.classList.remove("mx_DesktopShell", "cpd-theme-dark");
    });

    const renderRow = (): void => {
        flushSync(() =>
            root.render(
                <TooltipProvider>
                    <div className="mx_MemberListView">
                        <h2 className="mx_MemberListView_groupHeading">Staff — 1</h2>
                        <MemberTileView
                            ariaLabel="Cloud"
                            onClick={() => {}}
                            onFocus={() => {}}
                            memberIndex={0}
                            memberCount={1}
                            avatarJsx={
                                <>
                                    <Avatar className="mx_BaseAvatar" id="cloud" name="Cloud" size="32px" />
                                    <ProfileDecoration id="halo" />
                                </>
                            }
                            presenceJsx={
                                // The markup PresenceIconView renders in the desktop shell, without its tooltip.
                                <div className="mx_PresenceIconView">
                                    <PresenceGlyph status="online" className="mx_PresenceIconView_online" />
                                </div>
                            }
                            nameJsx="Cloud"
                            renderBackground={(textRef) => (
                                <ProfileNameplate nameplate={{ preset: "moonlit" }} live={false} textRef={textRef} />
                            )}
                        />
                    </div>
                </TooltipProvider>,
            ),
        );
    };

    it("lays a row out like Discord's: a 40px row, the avatar 8px in and the name 12px after it", () => {
        renderRow();
        const row = container.querySelector<HTMLElement>(".mx_MemberTileView")!;
        const avatar = container.querySelector<HTMLElement>(".mx_BaseAvatar")!.getBoundingClientRect();
        const name = container.querySelector<HTMLElement>(".mx_MemberTileView_name")!.getBoundingClientRect();
        const rowBox = row.getBoundingClientRect();

        expect(rowBox.height).toBe(40);
        expect(getComputedStyle(row).marginBlockStart).toBe("1px");
        expect(avatar.left - rowBox.left).toBe(8);
        expect(name.left - avatar.right).toBe(12);
        // A long name stops short of the nameplate's far end.
        expect(getComputedStyle(row).paddingInlineEnd).toBe("32px");
    });

    it("cuts the avatar and its decoration away around the status dot, centred 5px in from the corner", () => {
        renderRow();
        const avatar = container.querySelector<HTMLElement>(".mx_BaseAvatar")!;
        const decoration = container.querySelector<SVGElement>("svg[data-decoration]")!;
        const dot = container.querySelector(".mx_PresenceIconView svg")!.getBoundingClientRect();
        const box = avatar.getBoundingClientRect();

        expect(dot.left + dot.width / 2).toBe(box.right - 5);
        expect(dot.top + dot.height / 2).toBe(box.bottom - 5);
        expect(getComputedStyle(avatar).maskImage).toContain("radial-gradient");
        expect(getComputedStyle(decoration).maskImage).toContain("radial-gradient");
        // No painted ring: the cut shows whatever is behind the row.
        expect(getComputedStyle(container.querySelector(".mx_PresenceIconView")!).backgroundColor).toBe(
            "rgba(0, 0, 0, 0)",
        );
    });

    it("fades the nameplate art in across the row, on top of keeping it faint behind the name", () => {
        renderRow();
        const art = getComputedStyle(container.querySelector("[data-nameplate] canvas")!);
        expect(art.maskImage.match(/linear-gradient/g)).toHaveLength(2);
        expect(art.maskComposite).toMatch(/^intersect/);
    });

    it("writes group headings in sentence case", () => {
        renderRow();
        const heading = container.querySelector<HTMLElement>(".mx_MemberListView_groupHeading")!;
        expect(getComputedStyle(heading).textTransform).toBe("none");
    });
});
