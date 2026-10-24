/*
Copyright 2024 New Vector Ltd.
Copyright 2022 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import { describe, it, expect, vi } from "vitest";
import React from "react";
import { act, fireEvent, render } from "test-utils-rtl";
import { SettingsSolidIcon, VisibilityOnIcon, LabsIcon } from "@vector-im/compound-design-tokens/assets/web/icons";

import TabbedView, { Tab, TabLocation } from "./TabbedView";
import { type NonEmptyArray } from "../../@types/common";
import { _t } from "../../languageHandler";

describe("<TabbedView />", () => {
    const generalTab = new Tab("GENERAL", "common|general", <SettingsSolidIcon />, <div>general</div>);
    const labsTab = new Tab("LABS", "common|labs", <LabsIcon />, <div>labs</div>);
    const appearanceTab = new Tab("APPEARANCE", "common|appearance", <VisibilityOnIcon />, <div>appearance</div>);
    const defaultProps = {
        tabLocation: TabLocation.LEFT,
        tabs: [generalTab, labsTab, appearanceTab] as NonEmptyArray<Tab<any>>,
        onChange: () => {},
    };
    const getComponent = (
        props: {
            activeTabId: "GENERAL" | "LABS" | "APPEARANCE";
            onChange?: () => any;
            tabs?: NonEmptyArray<Tab<any>>;
        } = {
            activeTabId: "GENERAL",
        },
    ): React.ReactElement => <TabbedView {...defaultProps} {...props} />;

    const getTabTestId = (tab: Tab<string>): string => `settings-tab-${tab.id}`;
    const getActiveTab = (container: HTMLElement): Element | undefined =>
        container.getElementsByClassName("mx_TabbedView_tabLabel_active")[0];
    const getActiveTabBody = (container: HTMLElement): Element | undefined =>
        container.getElementsByClassName("mx_TabbedView_tabPanel")[0];

    it("renders tabs", () => {
        const { container } = render(getComponent());
        expect(container).toMatchSnapshot();
    });

    it("renders activeTabId tab as active when valid", () => {
        const { container } = render(getComponent({ activeTabId: appearanceTab.id }));
        expect(getActiveTab(container)?.textContent).toEqual(_t(appearanceTab.label));
        expect(getActiveTabBody(container)?.textContent).toEqual("appearance");
    });

    it("calls onchange on on tab click", () => {
        const onChange = vi.fn();
        const { getByTestId } = render(getComponent({ activeTabId: "GENERAL", onChange }));

        act(() => {
            fireEvent.click(getByTestId(getTabTestId(appearanceTab)));
        });

        expect(onChange).toHaveBeenCalledWith(appearanceTab.id);
    });

    it("keeps same tab active when order of tabs changes", () => {
        // start with middle tab active
        const { container, rerender } = render(getComponent({ activeTabId: labsTab.id }));

        expect(getActiveTab(container)?.textContent).toEqual(_t(labsTab.label));

        rerender(getComponent({ tabs: [labsTab, generalTab, appearanceTab], activeTabId: labsTab.id }));

        // labs tab still active
        expect(getActiveTab(container)?.textContent).toEqual(_t(labsTab.label));
    });

    describe("section links", () => {
        const sections = [
            { label: "common|general" as const, domId: "section-one" },
            { label: "common|labs" as const, domId: "section-two" },
        ];
        const tabWithAnchors = new Tab(
            "ANCHORED",
            "common|appearance",
            <VisibilityOnIcon />,
            <div>body</div>,
            undefined,
            undefined,
            sections,
        );

        it("lists the links under the open tab only", () => {
            const tabs = [generalTab, tabWithAnchors] as NonEmptyArray<Tab<any>>;
            const { queryByRole, rerender } = render(getComponent({ activeTabId: "GENERAL", tabs }));
            expect(queryByRole("button", { name: _t("common|labs") })).toBeNull();
            rerender(getComponent({ activeTabId: "ANCHORED" as never, tabs }));
            expect(queryByRole("button", { name: _t("common|general") })).not.toBeNull();
            expect(queryByRole("button", { name: _t("common|labs") })).not.toBeNull();
        });

        it("scrolls to the section and marks its link as current", () => {
            const target = document.createElement("h2");
            target.id = "section-two";
            target.scrollIntoView = vi.fn();
            document.body.append(target);
            const tabs = [tabWithAnchors] as NonEmptyArray<Tab<any>>;
            const { getByRole } = render(getComponent({ activeTabId: "ANCHORED" as never, tabs }));
            const link = getByRole("button", { name: _t("common|labs") });
            expect(link).not.toHaveAttribute("aria-current");
            fireEvent.click(link);
            expect(target.scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: "start" }));
            expect(link).toHaveAttribute("aria-current", "location");
            target.remove();
        });

        it("adds nothing for tabs without links", () => {
            const { container } = render(getComponent({ activeTabId: "GENERAL" }));
            expect(container.querySelector(".mx_TabbedView_anchors")).toBeNull();
        });
    });
});
