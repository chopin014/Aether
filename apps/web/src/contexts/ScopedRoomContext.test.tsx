/*
Copyright 2026 chopin014

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import React, { type JSX, useContext, useLayoutEffect } from "react";
import { act, render, screen } from "test-utils-rtl";
import { renderToStaticMarkup } from "react-dom/server";
import { Room } from "matrix-js-sdk/src/matrix";
import { beforeEach, describe, expect, it } from "vitest";
import { getRoomContext, stubClient } from "test-utils";

import { ScopedRoomContextProvider, useScopedRoomContext } from "./ScopedRoomContext";
import { ScopedRoomContext, ScopedRoomContextStore } from "./scoped-room-context-store";
import RoomContext, { type RoomContextType } from "./RoomContext";

type Key = keyof RoomContextType;

/** How often a reader rendered, and the fields it was handed each time. */
interface Renders {
    count: number;
    seen: object[];
}

const newRenders = (): Renders => ({ count: 0, seen: [] });

/** Shows the fields `keys` of the scoped room context it reads. */
function Reader({ keys, renders }: { keys: Key[]; renders?: Renders }): JSX.Element {
    const fields = useScopedRoomContext(...keys) as Partial<RoomContextType>;
    if (renders) {
        renders.count++;
        renders.seen.push(fields);
    }
    return <span data-testid="fields">{JSON.stringify(keys.map((key) => fields[key] ?? null))}</span>;
}

const shown = (): unknown => JSON.parse(screen.getByTestId("fields").textContent!);

describe("ScopedRoomContext", () => {
    let room: Room;
    const value = (override: Partial<RoomContextType>): RoomContextType => getRoomContext(room, override);

    beforeEach(() => {
        room = new Room("!room:example.org", stubClient(), "@me:example.org");
    });

    it("keeps selected snapshots stable for unrelated changes", () => {
        const store = new ScopedRoomContextStore(value({ numUnreadMessages: 1, showApps: false }));
        const renders = newRenders();
        render(
            <ScopedRoomContext.Provider value={store}>
                <Reader keys={["numUnreadMessages"]} renders={renders} />
            </ScopedRoomContext.Provider>,
        );
        expect(renders.count).toBe(1);

        act(() => store.publish(value({ numUnreadMessages: 1, showApps: true }), 1));
        expect(renders.count).toBe(1);

        act(() => store.publish(value({ numUnreadMessages: 2, showApps: true }), 2));
        expect(renders.count).toBe(2);
        expect(shown()).toEqual([2]);
        // Only the fields asked for are handed out.
        expect(renders.seen[1]).toEqual({ numUnreadMessages: 2 });
    });

    it("reads a replacement provider on the first render", () => {
        const first = new ScopedRoomContextStore(value({ numUnreadMessages: 1 }));
        const second = new ScopedRoomContextStore(value({ numUnreadMessages: 5 }));
        const renders = newRenders();
        const tree = (store: ScopedRoomContextStore): JSX.Element => (
            <ScopedRoomContext.Provider value={store}>
                <Reader keys={["numUnreadMessages"]} renders={renders} />
            </ScopedRoomContext.Provider>
        );
        const { rerender } = render(tree(first));

        rerender(tree(second));
        expect(renders.seen[1]).toEqual({ numUnreadMessages: 5 });
        expect(shown()).toEqual([5]);
    });

    it("changes selected keys without a store emission", () => {
        const store = new ScopedRoomContextStore(value({ numUnreadMessages: 3, showApps: true }));
        const { rerender } = render(
            <ScopedRoomContext.Provider value={store}>
                <Reader keys={["numUnreadMessages"]} />
            </ScopedRoomContext.Provider>,
        );
        expect(shown()).toEqual([3]);

        rerender(
            <ScopedRoomContext.Provider value={store}>
                <Reader keys={["showApps"]} />
            </ScopedRoomContext.Provider>,
        );
        expect(shown()).toEqual([true]);
    });

    it("observes a change between render and subscription", () => {
        const store = new ScopedRoomContextStore(value({ numUnreadMessages: 1 }));
        const next = value({ numUnreadMessages: 9 });
        // Published as the reader is committed, after it rendered and before it can have subscribed.
        function PublishOnMount(): null {
            useLayoutEffect(() => store.publish(next, 1), []);
            return null;
        }
        render(
            <ScopedRoomContext.Provider value={store}>
                <Reader keys={["numUnreadMessages"]} />
                <PublishOnMount />
            </ScopedRoomContext.Provider>,
        );
        expect(shown()).toEqual([9]);
    });

    it("renders to static markup, as a chat export does", () => {
        const markup = renderToStaticMarkup(
            <ScopedRoomContextProvider {...value({ numUnreadMessages: 4 })}>
                <Reader keys={["numUnreadMessages"]} />
            </ScopedRoomContextProvider>,
        );
        expect(markup).toContain("[4]");
    });

    it("preserves passive ordinary publication and absent-provider behavior", () => {
        const renders = newRenders();
        const { unmount } = render(<Reader keys={["numUnreadMessages"]} renders={renders} />);
        expect(renders.seen[0]).toEqual({});
        unmount();

        // What the store holds once the provider's own layout effects have run, during the commit of its new value,
        // and what the legacy context gives. Layout effects run child first, so a reader placed after the provider is
        // the one that sees the store after the provider's.
        let store: ScopedRoomContextStore | undefined;
        function CaptureStore(): null {
            store = useContext(ScopedRoomContext);
            return null;
        }
        const duringCommit: number[] = [];
        function SeesStoreAsCommitted(): null {
            useLayoutEffect(() => {
                duringCommit.push(store!.getSnapshot().value.numUnreadMessages);
            });
            return null;
        }
        function LegacyReader(): JSX.Element {
            return <span data-testid="legacy">{useContext(RoomContext).numUnreadMessages}</span>;
        }
        const tree = (unread: number): JSX.Element => (
            <>
                <ScopedRoomContextProvider {...value({ numUnreadMessages: unread })}>
                    <CaptureStore />
                    <LegacyReader />
                    <Reader keys={["numUnreadMessages"]} />
                </ScopedRoomContextProvider>
                <SeesStoreAsCommitted />
            </>
        );
        const { rerender } = render(tree(1));
        rerender(tree(2));

        // The legacy context has the new value as it renders; the store gets it only after the commit, as before.
        expect(duringCommit).toEqual([1, 1]);
        expect(screen.getByTestId("legacy").textContent).toBe("2");
        expect(shown()).toEqual([2]);
    });
});
