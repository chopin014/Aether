/*
Copyright 2024 New Vector Ltd.
Copyright 2019, 2020 , 2024 The Matrix.org Foundation C.I.C.
Copyright 2019 New Vector Ltd
Copyright 2017 Travis Ralston

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { type JSX } from "react";
import classNames from "classnames";
import { AutoHideScrollbar } from "@element-hq/web-shared-components";

import { _t } from "../../languageHandler";
import { PosthogScreenTracker, type ScreenName } from "../../PosthogTrackers";
import { type NonEmptyArray } from "../../@types/common";
import { RovingAccessibleButton, RovingTabIndexProvider } from "../../accessibility/RovingTabIndex";
import { useWindowWidth } from "../../hooks/useWindowWidth";

/** A link under a tab's label that scrolls the tab's page to one of its sections. */
export interface TabAnchor {
    /** The untranslated link text. */
    label: TranslationKey;
    /** The DOM id of the section the link scrolls to. */
    domId: string;
}

/**
 * Represents a tab for the TabbedView.
 */
export class Tab<T extends string> {
    /**
     * Creates a new tab.
     * @param {string} id The tab's ID.
     * @param {string} label The untranslated tab label.
     * @param {string|JSX.Element} icon An SVG element to use for the tab icon.
     * @param {JSX.Element} body The JSX for the tab container.
     * @param {string} screenName The screen name to report to Posthog.
     * @param {string} labelClassName Additional class to add to the tab label.
     * @param {TabAnchor[]} anchors Links to sections of the tab, listed under its label while it is open.
     */
    public constructor(
        public readonly id: T,
        public readonly label: TranslationKey,
        public readonly icon: JSX.Element | null,
        public readonly body: JSX.Element,
        public readonly screenName?: ScreenName,
        public readonly labelClassName?: string,
        public readonly anchors?: TabAnchor[],
    ) {}
}

export function useActiveTabWithDefault<T extends string>(
    tabs: NonEmptyArray<Tab<string>>,
    defaultTabID: T,
    initialTabID?: T,
): [T, (tabId: T) => void] {
    const [activeTabId, setActiveTabId] = React.useState(
        initialTabID && tabs.some((t) => t.id === initialTabID) ? initialTabID : defaultTabID,
    );

    return [activeTabId, setActiveTabId];
}

export enum TabLocation {
    LEFT = "left",
    TOP = "top",
}

interface ITabPanelProps<T extends string> {
    tab: Tab<T>;
}

function domIDForTabID(tabId: string): string {
    return `mx_tabpanel_${tabId}`;
}

function TabPanel<T extends string>({ tab }: ITabPanelProps<T>): JSX.Element {
    return (
        <div
            className="mx_TabbedView_tabPanel"
            key={tab.id}
            id={domIDForTabID(tab.id)}
            aria-labelledby={`${domIDForTabID(tab.id)}_label`}
        >
            <AutoHideScrollbar className="mx_AutoHideScrollbar mx_TabbedView_tabPanelContent">
                {tab.body}
            </AutoHideScrollbar>
        </div>
    );
}

/** The section links under the open tab. The link of the section nearest the top of the page is marked current. */
function TabAnchors({ tabId, anchors }: { tabId: string; anchors: TabAnchor[] }): JSX.Element {
    const [current, setCurrent] = React.useState(anchors[0].domId);

    React.useEffect(() => {
        const sections = anchors
            .map((anchor) => document.getElementById(anchor.domId))
            .filter((section): section is HTMLElement => !!section);
        const scroller = document.getElementById(domIDForTabID(tabId))?.querySelector(".mx_TabbedView_tabPanelContent");
        if (!scroller || typeof IntersectionObserver === "undefined") return;
        const visible = new Set<string>();
        // A section counts as current while it is in the top part of the page, so the link follows the scroll.
        const observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (entry.isIntersecting) visible.add(entry.target.id);
                    else visible.delete(entry.target.id);
                }
                const first = anchors.find((anchor) => visible.has(anchor.domId));
                if (first) setCurrent(first.domId);
            },
            { root: scroller, rootMargin: "0px 0px -70% 0px" },
        );
        sections.forEach((section) => observer.observe(section));
        return () => observer.disconnect();
    }, [tabId, anchors]);

    const onClick = (domId: string): void => {
        setCurrent(domId);
        const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
        document.getElementById(domId)?.scrollIntoView({ block: "start", behavior: reduceMotion ? "auto" : "smooth" });
    };

    return (
        <li role="presentation" className="mx_TabbedView_anchors">
            <ul>
                {anchors.map((anchor) => (
                    <li key={anchor.domId}>
                        <button
                            type="button"
                            className="mx_TabbedView_anchor"
                            aria-current={current === anchor.domId ? "location" : undefined}
                            onClick={() => onClick(anchor.domId)}
                        >
                            {_t(anchor.label)}
                        </button>
                    </li>
                ))}
            </ul>
        </li>
    );
}

interface ITabLabelProps<T extends string> {
    tab: Tab<T>;
    isActive: boolean;
    showToolip: boolean;
    onClick: () => void;
}

function TabLabel<T extends string>({ tab, isActive, showToolip, onClick }: ITabLabelProps<T>): JSX.Element {
    const classes = classNames("mx_TabbedView_tabLabel", tab.labelClassName, {
        mx_TabbedView_tabLabel_active: isActive,
    });

    let tabIcon: JSX.Element | undefined;
    if (tab.icon) {
        tabIcon = tab.icon;
    }

    const id = domIDForTabID(tab.id);

    const label = _t(tab.label);
    return (
        <RovingAccessibleButton
            className={classes}
            onClick={onClick}
            data-testid={`settings-tab-${tab.id}`}
            role="tab"
            aria-selected={isActive}
            aria-controls={id}
            element="li"
            title={showToolip ? label : undefined}
            aria-labelledby={`${id}_label`}
        >
            {tabIcon}
            <span className="mx_TabbedView_tabLabel_text" id={`${id}_label`}>
                {label}
            </span>
        </RovingAccessibleButton>
    );
}

interface IProps<T extends string> {
    // An array of objects representign tabs that the tabbed view will display.
    tabs: NonEmptyArray<Tab<T>>;
    // The ID of the tab to show
    activeTabId: T;
    // The location of the tabs, dictating the layout of the TabbedView.
    tabLocation?: TabLocation;
    // A callback that is called when the active tab should change
    onChange: (tabId: T) => void;
    // The screen name to report to Posthog.
    screenName?: ScreenName;
    /**
     * If true, the layout of the tabbed view will be responsive to the viewport size (eg, just showing icons
     * instead of names of tabs).
     * Only applies if `tabLocation === TabLocation.LEFT`.
     * Default: false.
     */
    responsive?: boolean;
}

/**
 * A tabbed view component. Given objects representing content with titles, displays
 * them in a tabbed view where the user can select which one of the items to view at once.
 */
export default function TabbedView<T extends string>(props: IProps<T>): JSX.Element {
    const tabLocation = props.tabLocation ?? TabLocation.LEFT;

    const getTabById = (id: T): Tab<T> | undefined => {
        return props.tabs.find((tab) => tab.id === id);
    };

    const windowWidth = useWindowWidth();

    const labels = props.tabs.map((tab) => (
        <React.Fragment key={"tab_label_" + tab.id}>
            <TabLabel
                tab={tab}
                isActive={tab.id === props.activeTabId}
                onClick={() => props.onChange(tab.id)}
                // This should be the same as the the CSS breakpoint at which the tab labels are hidden
                showToolip={windowWidth < 1024 && tabLocation == TabLocation.LEFT}
            />
            {tab.id === props.activeTabId && tab.anchors && <TabAnchors tabId={tab.id} anchors={tab.anchors} />}
        </React.Fragment>
    ));
    const tab = getTabById(props.activeTabId);
    const panel = tab ? <TabPanel tab={tab} /> : null;

    const tabbedViewClasses = classNames({
        mx_TabbedView: true,
        mx_TabbedView_tabsOnLeft: tabLocation == TabLocation.LEFT,
        mx_TabbedView_tabsOnTop: tabLocation == TabLocation.TOP,
        mx_TabbedView_responsive: props.responsive,
    });

    const screenName = tab?.screenName ?? props.screenName;

    return (
        <div className={tabbedViewClasses}>
            {screenName && <PosthogScreenTracker screenName={screenName} />}
            <RovingTabIndexProvider
                handleLoop
                handleHomeEnd
                handleLeftRight={tabLocation == TabLocation.TOP}
                handleUpDown={tabLocation == TabLocation.LEFT}
            >
                {({ onKeyDownHandler }) => (
                    <ul
                        className="mx_TabbedView_tabLabels"
                        role="tablist"
                        aria-orientation={tabLocation == TabLocation.LEFT ? "vertical" : "horizontal"}
                        onKeyDown={onKeyDownHandler}
                    >
                        {labels}
                    </ul>
                )}
            </RovingTabIndexProvider>
            {panel}
        </div>
    );
}
