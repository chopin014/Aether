/*
Copyright 2024 New Vector Ltd.
Copyright 2022 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import { vi, describe, it, expect, afterEach, beforeEach, type MockedObject } from "vitest";
import { type MatrixClient, type MatrixEvent, RoomMember } from "matrix-js-sdk/src/matrix";
import { mkMessage, stubClient } from "test-utils";

import { MatrixClientPeg } from "../../MatrixClientPeg";
import DMRoomMap from "../../utils/DMRoomMap";
import { Action } from "../../dispatcher/actions";
import defaultDispatcher from "../../dispatcher/dispatcher";
import { type ActiveRoomChangedPayload } from "../../dispatcher/payloads/ActiveRoomChangedPayload";
import RightPanelStore from "./RightPanelStore";
import { RightPanelPhases } from "./RightPanelStorePhases";
import SettingsStore from "../../settings/SettingsStore";
import { SettingLevel } from "../../settings/SettingLevel";
import { pendingVerificationRequestForUser } from "../../verification.ts";

vi.mock("../../verification");

describe("RightPanelStore", () => {
    // The store persists its own phase history, which would otherwise carry across rooms and tests.
    // Everything else is left alone so tests can write real settings, e.g. the labs flags below.
    const realSetValue = SettingsStore.setValue.bind(SettingsStore);
    vi.spyOn(SettingsStore, "setValue").mockImplementation((name, ...args) =>
        name === "RightPanel.phases" ? Promise.resolve() : realSetValue(name, ...args),
    );

    const store = RightPanelStore.instance;
    let cli: MockedObject<MatrixClient>;
    beforeEach(() => {
        stubClient();
        cli = vi.mocked(MatrixClientPeg.safeGet());
        DMRoomMap.makeShared(cli);

        // Make sure we start with a clean store
        store.reset();
        store.useUnitTestClient(cli);
    });

    // Stops anything the store persists, or a setting a test writes, leaking into the next one.
    afterEach(() => {
        SettingsStore.reset();
    });

    const viewRoom = async (roomId: string) => {
        const roomChanged = new Promise<void>((resolve) => {
            const ref = defaultDispatcher.register((payload) => {
                if (payload.action === Action.ActiveRoomChanged && payload.newRoomId === roomId) {
                    defaultDispatcher.unregister(ref);
                    resolve();
                }
            });
        });

        defaultDispatcher.dispatch<ActiveRoomChangedPayload>({
            action: Action.ActiveRoomChanged,
            oldRoomId: null,
            newRoomId: roomId,
        });

        await roomChanged;
    };

    const setCard = (roomId: string, phase: RightPanelPhases) => store.setCard({ phase }, true, roomId);

    describe("desktop thread navigation", () => {
        const roomId = "!1:example.org";
        const threadCard = () => ({
            phase: RightPanelPhases.ThreadView,
            state: {
                threadHeadEvent: mkMessage({ user: cli.getSafeUserId(), room: roomId, event: true, msg: "Starter" }),
            },
        });

        it("restores the member panel after closing a thread", async () => {
            await viewRoom(roomId);
            setCard(roomId, RightPanelPhases.MemberList);
            const previous = store.roomPhaseHistory;
            store.openThread(threadCard(), roomId);
            expect(store.currentCard.phase).toBe(RightPanelPhases.ThreadView);
            store.closeThread(roomId);
            expect(store.roomPhaseHistory).toEqual(previous);
            expect(store.currentCard.phase).toBe(RightPanelPhases.MemberList);
            expect(store.isOpen).toBe(true);
        });

        it("retains a closed panel's visibility when the thread closes", async () => {
            await viewRoom(roomId);
            setCard(roomId, RightPanelPhases.MemberList);
            store.hide(roomId);
            store.openThread(threadCard(), roomId);
            expect(store.isOpen).toBe(true);
            store.closeThread(roomId);
            expect(store.isOpen).toBe(false);
            expect(store.currentCard.phase).toBe(RightPanelPhases.MemberList);
        });

        it("keeps the original panel through thread switches without stacking conversations", async () => {
            await viewRoom(roomId);
            setCard(roomId, RightPanelPhases.PinnedMessages);
            const previous = store.roomPhaseHistory;
            const first = threadCard();
            const second = threadCard();
            store.openThread(first, roomId);
            store.openThread(second, roomId);
            expect(store.roomPhaseHistory).toEqual([...previous, second]);
            store.closeThread(roomId);
            expect(store.roomPhaseHistory).toEqual(previous);
        });

        it("does not restore another room's panel or reopen one after closing without history", async () => {
            await viewRoom(roomId);
            store.openThread(threadCard(), roomId);
            setCard("!other:example.org", RightPanelPhases.MemberList);
            store.closeThread(roomId);
            expect(store.isOpenForRoom(roomId)).toBe(false);
            expect(store.currentCardForRoom("!other:example.org").phase).toBe(RightPanelPhases.MemberList);
        });

        it("captures a newly selected panel after the user leaves a conversation", async () => {
            await viewRoom(roomId);
            setCard(roomId, RightPanelPhases.MemberList);
            store.openThread(threadCard(), roomId);
            setCard(roomId, RightPanelPhases.PinnedMessages);
            store.openThread(threadCard(), roomId);
            store.closeThread(roomId);
            expect(store.currentCard.phase).toBe(RightPanelPhases.PinnedMessages);
        });
    });

    describe("isOpen", () => {
        it("is false if no rooms are open", () => {
            expect(store.isOpen).toEqual(false);
        });
        it("is false if a room other than the current room is open", async () => {
            await viewRoom("!1:example.org");
            setCard("!2:example.org", RightPanelPhases.RoomSummary);
            expect(store.isOpen).toEqual(false);
        });
        it("is true if the current room is open", async () => {
            await viewRoom("!1:example.org");
            setCard("!1:example.org", RightPanelPhases.RoomSummary);
            expect(store.isOpen).toEqual(true);
        });
    });

    describe("currentCard", () => {
        it("has a phase of null if nothing is open", () => {
            expect(store.currentCard.phase).toEqual(null);
        });
        it("has a phase of null if the panel is open but in another room", async () => {
            await viewRoom("!1:example.org");
            setCard("!2:example.org", RightPanelPhases.RoomSummary);
            expect(store.currentCard.phase).toEqual(null);
        });
        it("reflects the phase of the current room", async () => {
            await viewRoom("!1:example.org");
            setCard("!1:example.org", RightPanelPhases.RoomSummary);
            expect(store.currentCard.phase).toEqual(RightPanelPhases.RoomSummary);
        });
    });

    describe("setCard", () => {
        it("does nothing if given no room ID and not viewing a room", () => {
            store.setCard({ phase: RightPanelPhases.RoomSummary }, true);
            expect(store.isOpen).toEqual(false);
            expect(store.currentCard.phase).toEqual(null);
        });
        it("does nothing if given an invalid state", async () => {
            await viewRoom("!1:example.org");
            // Needs a member specified to be valid
            store.setCard({ phase: RightPanelPhases.MemberInfo }, true, "!1:example.org");
            expect(store.roomPhaseHistory).toEqual([]);
        });
        it("only creates a single history entry if given the same card twice", async () => {
            await viewRoom("!1:example.org");
            store.setCard({ phase: RightPanelPhases.RoomSummary }, true, "!1:example.org");
            store.setCard({ phase: RightPanelPhases.RoomSummary }, true, "!1:example.org");
            expect(store.roomPhaseHistory).toEqual([{ phase: RightPanelPhases.RoomSummary, state: {} }]);
        });
        it("opens the panel in the given room with the correct phase", () => {
            store.setCard({ phase: RightPanelPhases.RoomSummary }, true, "!1:example.org");
            expect(store.isOpenForRoom("!1:example.org")).toEqual(true);
            expect(store.currentCardForRoom("!1:example.org").phase).toEqual(RightPanelPhases.RoomSummary);
        });
        it("reopens a closed panel when the card already at the top is given new state", async () => {
            await viewRoom("!1:example.org");
            const cardForEvent = (eventId: string) => ({
                phase: RightPanelPhases.Timeline,
                state: { initialEvent: { getId: () => eventId } as unknown as MatrixEvent },
            });

            store.setCard(cardForEvent("$one"), true, "!1:example.org");
            expect(store.isOpenForRoom("!1:example.org")).toEqual(true);

            store.hide("!1:example.org");
            expect(store.isOpenForRoom("!1:example.org")).toEqual(false);

            // Same phase, different state: the panel has to come back, not just swap state behind a
            // hidden panel. This is what selecting a second file to view does.
            store.setCard(cardForEvent("$two"), true, "!1:example.org");
            expect(store.isOpenForRoom("!1:example.org")).toEqual(true);
            expect(store.currentCardForRoom("!1:example.org").state?.initialEvent?.getId()).toEqual("$two");
        });
        describe("DocumentViewer", () => {
            const documentCard = {
                phase: RightPanelPhases.DocumentViewer,
                state: { documentViewerEvent: { getId: () => "$document" } as unknown as MatrixEvent },
            };

            /** The viewers sit behind a lab, so the card is only valid while that is on. */
            const setDocumentPreviewsLab = (enabled: boolean): Promise<void> =>
                SettingsStore.setValue("feature_pdf_viewer", null, SettingLevel.DEVICE, enabled);

            it("drops a card with no event to display", async () => {
                await setDocumentPreviewsLab(true);
                await viewRoom("!1:example.org");

                store.setCard({ phase: RightPanelPhases.DocumentViewer }, true, "!1:example.org");

                expect(store.roomPhaseHistory).toEqual([]);
            });

            it("opens the card for the event when the open action is dispatched", async () => {
                await setDocumentPreviewsLab(true);
                await viewRoom("!1:example.org");
                const event = {
                    getId: () => "$document",
                    getRoomId: () => "!1:example.org",
                } as unknown as MatrixEvent;

                defaultDispatcher.dispatch({ action: Action.OpenDocumentViewer, event }, true);

                expect(store.currentCardForRoom("!1:example.org").phase).toEqual(RightPanelPhases.DocumentViewer);
                expect(store.currentCardForRoom("!1:example.org").state?.documentViewerEvent).toBe(event);
                expect(store.isOpenForRoom("!1:example.org")).toEqual(true);
            });

            it("keeps a card with an event to display", async () => {
                await setDocumentPreviewsLab(true);
                await viewRoom("!1:example.org");

                store.setCard(documentCard, true, "!1:example.org");

                expect(store.currentCardForRoom("!1:example.org").phase).toEqual(RightPanelPhases.DocumentViewer);
            });

            it("drops an otherwise valid card while the lab is off", async () => {
                await setDocumentPreviewsLab(false);
                await viewRoom("!1:example.org");

                store.setCard(documentCard, true, "!1:example.org");

                expect(store.roomPhaseHistory).toEqual([]);
            });
        });
        it("history is generated for certain phases", async () => {
            await viewRoom("!1:example.org");
            // Setting the memberlist card should also generate a history with room summary card
            store.setCard({ phase: RightPanelPhases.MemberList }, true, "!1:example.org");
            expect(store.roomPhaseHistory).toEqual([
                { phase: RightPanelPhases.RoomSummary, state: {} },
                { phase: RightPanelPhases.MemberList, state: {} },
            ]);
        });
    });

    describe("setCards", () => {
        it("overwrites history", async () => {
            await viewRoom("!1:example.org");
            store.setCard({ phase: RightPanelPhases.MemberList }, true, "!1:example.org");
            store.setCards(
                [{ phase: RightPanelPhases.RoomSummary }, { phase: RightPanelPhases.PinnedMessages }],
                true,
                "!1:example.org",
            );
            expect(store.roomPhaseHistory).toEqual([
                { phase: RightPanelPhases.RoomSummary, state: {} },
                { phase: RightPanelPhases.PinnedMessages, state: {} },
            ]);
        });
    });

    describe("pushCard", () => {
        it("does nothing if given no room ID and not viewing a room", () => {
            store.pushCard({ phase: RightPanelPhases.RoomSummary }, true);
            expect(store.isOpen).toEqual(false);
            expect(store.currentCard.phase).toEqual(null);
        });
        it("opens the panel in the given room with the correct phase", () => {
            store.pushCard({ phase: RightPanelPhases.RoomSummary }, true, "!1:example.org");
            expect(store.isOpenForRoom("!1:example.org")).toEqual(true);
            expect(store.currentCardForRoom("!1:example.org").phase).toEqual(RightPanelPhases.RoomSummary);
        });
        it("appends the phase to any phases that were there before", async () => {
            await viewRoom("!1:example.org");
            store.setCard({ phase: RightPanelPhases.RoomSummary }, true, "!1:example.org");
            store.pushCard({ phase: RightPanelPhases.PinnedMessages }, true, "!1:example.org");
            expect(store.roomPhaseHistory).toEqual([
                { phase: RightPanelPhases.RoomSummary, state: {} },
                { phase: RightPanelPhases.PinnedMessages, state: {} },
            ]);
        });
    });

    describe("popCard", () => {
        it("removes the most recent card", () => {
            store.setCards(
                [{ phase: RightPanelPhases.RoomSummary }, { phase: RightPanelPhases.PinnedMessages }],
                true,
                "!1:example.org",
            );
            expect(store.currentCardForRoom("!1:example.org").phase).toEqual(RightPanelPhases.PinnedMessages);
            store.popCard("!1:example.org");
            expect(store.currentCardForRoom("!1:example.org").phase).toEqual(RightPanelPhases.RoomSummary);
        });
    });

    describe("togglePanel", () => {
        it("does nothing if the room has no phase to open to", () => {
            expect(store.isOpenForRoom("!1:example.org")).toEqual(false);
            store.togglePanel("!1:example.org");
            expect(store.isOpenForRoom("!1:example.org")).toEqual(false);
        });
        it("works if a room is specified", () => {
            store.setCard({ phase: RightPanelPhases.RoomSummary }, true, "!1:example.org");
            expect(store.isOpenForRoom("!1:example.org")).toEqual(true);
            store.togglePanel("!1:example.org");
            expect(store.isOpenForRoom("!1:example.org")).toEqual(false);
            store.togglePanel("!1:example.org");
            expect(store.isOpenForRoom("!1:example.org")).toEqual(true);
        });
        it("operates on the current room if no room is specified", async () => {
            await viewRoom("!1:example.org");
            store.setCard({ phase: RightPanelPhases.RoomSummary }, true);
            expect(store.isOpen).toEqual(true);
            store.togglePanel(null);
            expect(store.isOpen).toEqual(false);
            store.togglePanel(null);
            expect(store.isOpen).toEqual(true);
        });
    });

    describe("in the desktop shell", () => {
        beforeEach(async () => {
            await SettingsStore.setValue("feature_desktop_shell", null, SettingLevel.DEVICE, true);
        });

        it("never shows the room summary card, nor offers it as a way back", async () => {
            await viewRoom("!channel:example.org");
            store.setCard({ phase: RightPanelPhases.RoomSummary }, true, "!channel:example.org");
            expect(store.currentCard.phase).not.toEqual(RightPanelPhases.RoomSummary);
            store.pushCard({ phase: RightPanelPhases.RoomSummary }, true, "!channel:example.org");
            expect(store.roomPhaseHistory.map((card) => card.phase)).not.toContain(RightPanelPhases.RoomSummary);

            store.setCard({ phase: RightPanelPhases.PinnedMessages }, true, "!channel:example.org");
            expect(store.roomPhaseHistory.map((card) => card.phase)).toEqual([RightPanelPhases.PinnedMessages]);
            store.setCards(
                [{ phase: RightPanelPhases.RoomSummary }, { phase: RightPanelPhases.MemberList }],
                true,
                "!channel:example.org",
            );
            store.pushCard({ phase: RightPanelPhases.ThreadPanel }, true, "!channel:example.org");
            expect(store.roomPhaseHistory.map((card) => card.phase)).not.toContain(RightPanelPhases.RoomSummary);
        });

        it("opens a text channel on its member list", async () => {
            await viewRoom("!channel:example.org");
            expect(store.isOpen).toEqual(true);
            expect(store.currentCard.phase).toEqual(RightPanelPhases.MemberList);
        });

        it("keeps a channel closed once the user has closed it", async () => {
            await viewRoom("!channel:example.org");
            store.togglePanel(null);
            await viewRoom("!other:example.org");
            await viewRoom("!channel:example.org");
            expect(store.isOpen).toEqual(false);
        });

        it.each([
            ["a voice channel", "isCallRoom"],
            ["a Space", "isSpaceRoom"],
        ] as const)("leaves %s closed", async (_, kind) => {
            const room = cli.getRoom("!voice:example.org")!;
            vi.mocked(room[kind]).mockReturnValue(true);
            cli.getRoom.mockReturnValue(room);
            await viewRoom("!voice:example.org");
            expect(store.isOpen).toEqual(false);
        });

        it("leaves a direct message closed", async () => {
            vi.spyOn(DMRoomMap.shared(), "getUserIdForRoomId").mockReturnValue("@alice:example.org");
            await viewRoom("!dm:example.org");
            expect(store.isOpen).toEqual(false);
        });
    });

    it("doesn't restore member info cards when switching back to a room", async () => {
        await viewRoom("!1:example.org");
        store.setCards(
            [
                {
                    phase: RightPanelPhases.MemberList,
                },
                {
                    phase: RightPanelPhases.MemberInfo,
                    state: { member: new RoomMember("!1:example.org", "@alice:example.org") },
                },
            ],
            true,
            "!1:example.org",
        );
        expect(store.currentCardForRoom("!1:example.org").phase).toEqual(RightPanelPhases.MemberInfo);

        // Switch away and back
        await viewRoom("!2:example.org");
        await viewRoom("!1:example.org");
        expect(store.currentCardForRoom("!1:example.org").phase).toEqual(RightPanelPhases.MemberList);
    });

    it("still shows the room summary card outside the desktop shell", async () => {
        await SettingsStore.setValue("feature_desktop_shell", null, SettingLevel.DEVICE, false);
        await viewRoom("!1:example.org");
        store.setCard({ phase: RightPanelPhases.RoomSummary }, true, "!1:example.org");
        expect(store.currentCard.phase).toEqual(RightPanelPhases.RoomSummary);
    });

    it("should redirect to verification if set to phase MemberInfo for a user with a pending verification", async () => {
        const member = new RoomMember("!1:example.org", "@alice:example.org");
        const verificationRequest = { mockVerificationRequest: true } as any;
        vi.mocked(pendingVerificationRequestForUser).mockReturnValue(verificationRequest);
        await viewRoom("!1:example.org");
        store.setCard(
            {
                phase: RightPanelPhases.MemberInfo,
                state: { member },
            },
            true,
            "!1:example.org",
        );
        expect(store.currentCard).toEqual({
            phase: RightPanelPhases.EncryptionPanel,
            state: { member, verificationRequest },
        });
    });
});
