/*
Copyright 2026 Element Creations Ltd.
Copyright 2024 New Vector Ltd.
Copyright 2022 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import React from "react";
import userEvent from "@testing-library/user-event";
import { render, screen, fireEvent, act, cleanup, waitFor, within } from "test-utils-rtl";
import { type MatrixClient, type Room } from "matrix-js-sdk/src/matrix";
import { mkStubRoom, wrapInMatrixClientContext, wrapInSdkContext, TestSDKContext } from "test-utils";

import { RoomListCollapsedContext } from "../../../contexts/RoomListCollapsedContext";
import { MatrixClientPeg } from "../../../MatrixClientPeg";
import { MetaSpace, type SpaceKey } from "../../../stores/spaces";
import { shouldShowComponent } from "../../../customisations/helpers/UIComponents";
import { UIComponent } from "../../../settings/UIFeature";
import DMRoomMap from "../../../utils/DMRoomMap";
import { type SpaceNotificationState } from "../../../stores/notifications/SpaceNotificationState";
import SettingsStore from "../../../settings/SettingsStore";
import UnwrappedSpacePanel from "./SpacePanel";
import defaultDispatcher from "../../../dispatcher/dispatcher";
import { Action } from "../../../dispatcher/actions";
import { Filter } from "../dialogs/spotlight/Filter";

// DND test utilities based on
// https://github.com/colinrobertbrooks/react-beautiful-dnd-test-utils/issues/18#issuecomment-1373388693
enum Keys {
    SPACE = 32,
    ARROW_LEFT = 37,
    ARROW_UP = 38,
    ARROW_RIGHT = 39,
    ARROW_DOWN = 40,
}

/* oxlint-disable typescript/prefer-literal-enum-member */
enum DragDirection {
    LEFT = Keys.ARROW_LEFT,
    UP = Keys.ARROW_UP,
    RIGHT = Keys.ARROW_RIGHT,
    DOWN = Keys.ARROW_DOWN,
}
/* oxlint-enable typescript/prefer-literal-enum-member */

// taken from https://github.com/hello-pangea/dnd/blob/main/test/unit/integration/util/controls.ts#L20
const createTransitionEndEvent = (): Event => {
    const event = new Event("transitionend", {
        bubbles: true,
        cancelable: true,
    }) as TransitionEvent;

    // cheating and adding property to event as
    // TransitionEvent constructor does not exist.
    // This is needed because of the following check
    //   https://github.com/atlassian/react-beautiful-dnd/blob/master/src/view/draggable/draggable.jsx#L130
    (event as any).propertyName = "transform";

    return event;
};

const pickUp = async (element: HTMLElement) => {
    fireEvent.keyDown(element, {
        keyCode: Keys.SPACE,
    });
    await screen.findByText(/You have lifted an item/i);

    act(() => {
        vi.runOnlyPendingTimers();
    });
};

const move = async (element: HTMLElement, direction: DragDirection) => {
    fireEvent.keyDown(element, {
        keyCode: direction,
    });
    await screen.findByText(/(You have moved the item | has been combined with)/i);
};

const drop = async (element: HTMLElement) => {
    fireEvent.keyDown(element, {
        keyCode: Keys.SPACE,
    });
    fireEvent(element.parentElement!, createTransitionEndEvent());

    await screen.findByText(/You have dropped the item/i);
};

vi.mock("../../../stores/spaces/SpaceStore", async () => {
    const { EventEmitter } = await vi.importActual<typeof import("events")>("events");
    class MockSpaceStore extends EventEmitter {
        invitedSpaces: SpaceKey[] = [];
        enabledMetaSpaces: MetaSpace[] = [];
        spacePanelSpaces: string[] = [];
        activeSpace: SpaceKey = "!space1";
        getChildSpaces = () => [] as Room[];
        getNotificationState = () => null as SpaceNotificationState | null;
        setActiveSpace = vi.fn();
        moveRootSpace = vi.fn();
        start = vi.fn();
    }
    return { default: MockSpaceStore };
});

vi.mock("../../../customisations/helpers/UIComponents", () => ({
    shouldShowComponent: vi.fn(),
}));

describe("<SpacePanel />", () => {
    const mockClient = {
        getUserId: vi.fn().mockReturnValue("@test:test"),
        getSafeUserId: vi.fn().mockReturnValue("@test:test"),
        getClientWellKnown: vi.fn(),
        mxcUrlToHttp: vi.fn(),
        getRoom: vi.fn(),
        isGuest: vi.fn(),
        getAccountData: vi.fn(),
        on: vi.fn(),
        off: vi.fn(),
        removeListener: vi.fn(),
        isVersionSupported: vi.fn().mockResolvedValue(true),
        doesServerSupportUnstableFeature: vi.fn().mockResolvedValue(false),
        getAuthMetadata: vi.fn().mockRejectedValue(new Error("Legacy auth")),
        getSyncState: vi.fn().mockReturnValue("SYNCING"),
    } as unknown as MatrixClient;
    const sdkContext = new TestSDKContext();
    const SpacePanel = wrapInSdkContext(wrapInMatrixClientContext(UnwrappedSpacePanel), sdkContext);

    beforeAll(() => {
        vi.spyOn(MatrixClientPeg, "get").mockReturnValue(mockClient);
        vi.spyOn(MatrixClientPeg, "safeGet").mockReturnValue(mockClient);
        sdkContext._client = mockClient;
    });

    beforeEach(() => {
        sdkContext.spaceStore.enabledMetaSpaces.push(MetaSpace.Home, MetaSpace.Orphans, MetaSpace.VideoRooms);
        vi.mocked(shouldShowComponent).mockClear().mockReturnValue(true);
    });
    afterEach(() => {
        cleanup();
        vi.useRealTimers();
    });

    it("should show all activated MetaSpaces in the correct order", async () => {
        const originalGetValue = SettingsStore.getValue;
        const spySettingsStore = vi.spyOn(SettingsStore, "getValue").mockImplementation((setting) => {
            return setting === "feature_video_rooms" ? true : originalGetValue(setting);
        });
        render(<SpacePanel />);

        // Inspect the order of the rendered MetaSpaces, excluding the "Create a server" button.
        const tree = screen.getByRole("tree", { name: "Spaces" });
        const spaceButtons = within(tree)
            .getAllByRole("treeitem")
            .filter((el) => within(el).queryByRole("button", { name: "Create a server" }) === null);

        const metaSpaceLabels = Array.from(spaceButtons).map((li) =>
            within(li)
                .getByRole("button", { name: /^(?!Options$).*/ }) // filter out the 'options' buttons within the buttons
                .getAttribute("aria-label"),
        );
        expect(metaSpaceLabels).toEqual(["Home", "Other rooms", "Conferences"]);
        // Meta spaces are marked so the desktop shell can divide them from the user's Spaces
        expect(spaceButtons.every((li) => li.classList.contains("mx_SpaceItem_meta"))).toBe(true);
        const createSpace = within(tree).getByRole("button", { name: "Create a server" }).closest("li");
        expect(createSpace).not.toHaveClass("mx_SpaceItem_meta");

        spySettingsStore.mockRestore();
    });

    it("returns the account menu to the rail when the desktop sidebar collapses", () => {
        const getValue = SettingsStore.getValue.bind(SettingsStore);
        const settings = vi
            .spyOn(SettingsStore, "getValue")
            .mockImplementation((name, ...args) => (name === "feature_desktop_shell" ? true : getValue(name, ...args)));
        const { rerender } = render(
            <RoomListCollapsedContext.Provider value={false}>
                <SpacePanel />
            </RoomListCollapsedContext.Provider>,
        );
        expect(screen.queryByRole("button", { name: "User menu" })).not.toBeInTheDocument();
        rerender(
            <RoomListCollapsedContext.Provider value={true}>
                <SpacePanel />
            </RoomListCollapsedContext.Provider>,
        );
        expect(screen.getByRole("button", { name: "User menu" })).toBeInTheDocument();
        settings.mockRestore();
    });

    it("marks Home with the Aether symbol in the desktop shell", () => {
        const getValue = SettingsStore.getValue.bind(SettingsStore);
        const settings = vi
            .spyOn(SettingsStore, "getValue")
            .mockImplementation((name, ...args) => (name === "feature_desktop_shell" ? true : getValue(name, ...args)));
        try {
            render(<SpacePanel />);
            const homeButtons = screen.getAllByRole("button", { name: "Home" });
            expect(homeButtons.some((button) => button.querySelector(".mx_DesktopShell_homeSymbol"))).toBe(true);
        } finally {
            settings.mockRestore();
        }
    });

    it("keeps the desktop server rail narrow without an expand control or shortcut", () => {
        const getValue = SettingsStore.getValue.bind(SettingsStore);
        const settings = vi
            .spyOn(SettingsStore, "getValue")
            .mockImplementation((name, ...args) => (name === "feature_desktop_shell" ? true : getValue(name, ...args)));
        try {
            render(<SpacePanel />);
            const rail = screen.getByRole("navigation", { name: "Spaces" });
            expect(rail).toHaveClass("collapsed");
            expect(screen.queryByRole("button", { name: "Expand" })).not.toBeInTheDocument();

            act(() => defaultDispatcher.dispatch({ action: Action.ToggleSpacePanel }, true));
            expect(rail).toHaveClass("collapsed");
        } finally {
            settings.mockRestore();
        }
    });

    it("retains the expand control and shortcut outside the desktop shell", () => {
        render(<SpacePanel />);
        expect(screen.queryByRole("button", { name: "Discover public servers" })).not.toBeInTheDocument();
        const rail = screen.getByRole("navigation", { name: "Spaces" });
        fireEvent.click(screen.getByRole("button", { name: "Expand" }));
        expect(rail).not.toHaveClass("collapsed");

        act(() => defaultDispatcher.dispatch({ action: Action.ToggleSpacePanel }, true));
        expect(rail).toHaveClass("collapsed");
        expect(screen.getByRole("button", { name: "Expand" })).toBeVisible();
    });

    describe("desktop Space discovery", () => {
        let settings: { mockRestore: () => void };

        beforeEach(() => {
            const getValue = SettingsStore.getValue.bind(SettingsStore);
            settings = vi
                .spyOn(SettingsStore, "getValue")
                .mockImplementation((name, ...args) =>
                    name === "feature_desktop_shell" ? true : getValue(name, ...args),
                );
        });

        afterEach(() => settings.mockRestore());

        it("should show an accessible Discover button immediately below Create a server", async () => {
            render(<SpacePanel />);
            const tree = screen.getByRole("tree", { name: "Spaces" });
            const create = within(tree).getByRole("button", { name: "Create a server" });
            const discover = within(tree).getByRole("button", { name: "Discover public servers" });

            expect(discover).toBeVisible();
            expect(create.closest("li")?.nextElementSibling).toBe(discover.closest("li"));
            expect(discover).toHaveClass("mx_SpaceButton_narrow");
            await userEvent.hover(discover);
            expect(await screen.findByRole("tooltip")).toHaveTextContent("Discover public servers");
        });

        it("should open public Spaces discovery without opening Create a server", () => {
            const dispatch = vi.spyOn(defaultDispatcher, "dispatch");
            try {
                render(<SpacePanel />);
                fireEvent.click(screen.getByRole("button", { name: "Discover public servers" }));
                expect(dispatch).toHaveBeenCalledWith({
                    action: Action.OpenSpotlight,
                    initialFilter: Filter.PublicSpaces,
                });
                expect(screen.getByRole("button", { name: "Create a server" })).toBeVisible();
                expect(screen.queryByRole("heading", { name: "Create a server" })).not.toBeInTheDocument();
            } finally {
                dispatch.mockRestore();
            }
        });

        it("should retain the separate Create a server menu", () => {
            const dispatch = vi.spyOn(defaultDispatcher, "dispatch");
            try {
                render(<SpacePanel />);
                fireEvent.click(screen.getByRole("button", { name: "Create a server" }));
                expect(screen.getByRole("heading", { name: "Create a server" })).toBeVisible();
                expect(screen.getByRole("button", { name: /^Public/ })).toBeVisible();
                expect(screen.getByRole("button", { name: /^Private/ })).toBeVisible();
                expect(screen.getByRole("button", { name: "Discover public servers" })).toBeVisible();
                expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ action: Action.OpenSpotlight }));
            } finally {
                dispatch.mockRestore();
            }
        });

        it("should offer discovery independently of the permission to create Spaces", () => {
            vi.mocked(shouldShowComponent).mockImplementation((component) => component !== UIComponent.CreateSpaces);
            render(<SpacePanel />);
            expect(screen.queryByRole("button", { name: "Create a server" })).not.toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Discover public servers" })).toBeVisible();
        });

        it("should respect the directory visibility configuration", () => {
            vi.mocked(shouldShowComponent).mockImplementation((component) => component !== UIComponent.ExploreRooms);
            render(<SpacePanel />);
            expect(screen.queryByRole("button", { name: "Discover public servers" })).not.toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Create a server" })).toBeVisible();
        });
    });

    describe("create new space button", () => {
        it("renders create space button when UIComponent.CreateSpaces component should be shown", () => {
            render(<SpacePanel />);
            expect(screen.getByTestId("create-space-button")).toBeVisible();
        });

        it("does not render create space button when UIComponent.CreateSpaces component should not be shown", () => {
            vi.mocked(shouldShowComponent).mockReturnValue(false);
            render(<SpacePanel />);
            expect(shouldShowComponent).toHaveBeenCalledWith(UIComponent.CreateSpaces);
            expect(screen.queryByTestId("create-space-button")).toBeFalsy();
        });

        it("opens context menu on create space button click", () => {
            render(<SpacePanel />);
            fireEvent.click(screen.getByTestId("create-space-button"));
            expect(screen.getByTestId("create-space-button")).toBeVisible();
        });
    });

    it("should allow rearranging via drag and drop", async () => {
        (sdkContext.spaceStore.spacePanelSpaces as any) = [
            mkStubRoom("!room1:server", "Room 1", mockClient),
            mkStubRoom("!room2:server", "Room 2", mockClient),
            mkStubRoom("!room3:server", "Room 3", mockClient),
        ];
        DMRoomMap.makeShared(mockClient);
        vi.useFakeTimers({ shouldAdvanceTime: true });

        const { getByLabelText } = render(<SpacePanel />);

        const room1 = getByLabelText("Room 1");
        await pickUp(room1);
        await move(room1, DragDirection.DOWN);
        await drop(room1);

        expect(sdkContext.spaceStore.moveRootSpace).toHaveBeenCalledWith(0, 1);
    });

    it("should be able to open the user menu via dispatcher", async () => {
        const { baseElement } = render(<SpacePanel />);
        defaultDispatcher.dispatch({ action: Action.ToggleUserMenu });
        await waitFor(() => {
            // Menu exists outside the component due to Portals, so select it manually.
            expect(baseElement.querySelector("div[aria-label='User menu']")).toBeInTheDocument();
        });
    });
});
