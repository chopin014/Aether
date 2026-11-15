/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React, { type FC, lazy, Suspense, useEffect, useMemo, useState } from "react";
import { type MatrixClient } from "matrix-js-sdk/src/matrix";
// Type-only: the component itself is loaded lazily below
import type * as ElementCallComponent from "@element-hq/element-call-component";

import { CallEvent, ElementCall as ElementCallModel } from "../../../models/Call";
import { CallStore } from "../../../stores/CallStore";
import { useSettingValue } from "../../../hooks/useSettings";
import { getCurrentLanguage } from "../../../languageHandler";
import { useTheme } from "../../../hooks/useTheme";
import Spinner from "../elements/Spinner";
import { getLoadedElementCallComponent, loadElementCallComponent } from "./ElementCallLoader";
import { ElementWebHostBridge } from "./ElementWebHostBridge";
import { DesktopCallStage } from "./DesktopCallStage";
import { pendingCallPresentation } from "./pendingCallPresentation";
import { useTypedEventEmitterState } from "../../../hooks/useEventEmitter";

/**
 * What `WrappedElementCallComponent` needs from an Element Call component module: satisfied by
 * `@element-hq/element-call-component` and by `ElementCallMock`, which is typed against the same
 * package types.
 */
type ElementCallComponentModule = Pick<typeof ElementCallComponent, "ElementCall" | "initializeElementCall">;

/**
 * Loads an Element Call component module and initialises it once, before its first render.
 */
const loadElementCall = async (
    module: Promise<ElementCallComponentModule>,
): Promise<{ default: ElementCallComponentModule["ElementCall"] }> => {
    const m = await module;
    await m.initializeElementCall(ElementCallModel.getConfigOptions(CallStore.instance.getConfiguredRTCTransports()));
    return { default: m.ElementCall };
};

/**
 * The real component: `@element-hq/element-call-component`, a large ES module (LiveKit, EC's UI) plus
 * its stylesheet (imported into the `element-call` cascade layer by `ElementCallComponent.css`).
 * Code-split for the React path; the desktop shell can preload it while idle.
 */
const RealElementCall = lazy(loadElementCallComponent);

/**
 * The mock, for Playwright (no LiveKit in Element Web's test backend) and offline development. Only
 * fetched when `Developer.elementCallMockComponent` is on.
 */
const MockElementCall = lazy(() =>
    loadElementCall(import(/* webpackChunkName: "element-call-mock" */ "./ElementCallMock")),
);

/**
 * Marks the call ready once the (lazily loaded) Element Call component has mounted. Element Call's
 * component build does not call `HostBridge.contentLoaded()` yet (only its standalone app does), and
 * the `ElementCall` model's `start()` would otherwise time out waiting for it. Harmless if the
 * component does call it too (the mock does).
 */
const MarkReadyOnMount = ({ call }: { call: ElementCallModel }): null => {
    useEffect(() => call.markReady(), [call]);
    return null;
};

/**
 * Wraps the Element Call component and constructs everything ElementCall needs.
 * from just: call + client.
 * Rendered inside the persisted root, where it lives for the whole call regardless of which tile
 * (room view, floating PiP) is showing the call, or whether any is (browser Picture-in-Picture window):
 * so this is where anything that must keep following Element Web while the call runs,
 * the theme and the language, is read.
 *
 * What the component reconnects on (`intent`, `config`) is decided once per call by the model; what it
 * takes live (`theme`, `language`, `hostBridge`) may change freely.
 */
export const WrappedElementCallComponent: FC<{ call: ElementCallModel; client: MatrixClient }> = ({ call, client }) => {
    // Real component or mock: independent of the widget-vs-React choice CallAppTile makes.
    const useMock = Boolean(useSettingValue("Developer.elementCallMockComponent"));
    const desktopShell = Boolean(useSettingValue("feature_desktop_shell"));
    // The component is rendered directly once loaded (usually while idle, before any call), not through `lazy`: a
    // render that suspends is held back by React for a few hundred milliseconds even after it could go on. Only if
    // loading fails is it left to `lazy`, which tries again and reports the error.
    const [loadedComponent, setLoadedComponent] = useState(getLoadedElementCallComponent);
    const [loadFailed, setLoadFailed] = useState(false);
    useEffect(() => {
        if (useMock || loadedComponent) return;
        let mounted = true;
        loadElementCallComponent().then(
            ({ default: component }) => mounted && setLoadedComponent(() => component),
            () => mounted && setLoadFailed(true),
        );
        return () => {
            mounted = false;
        };
    }, [useMock, loadedComponent]);
    const ElementCall = useMock ? MockElementCall : (loadedComponent ?? (loadFailed ? RealElementCall : undefined));
    const { effectiveTheme: theme } = useTheme();
    // Not a hook: changing the language reloads Element Web, so there is no live change to follow
    const language = getCurrentLanguage().replace("_", "-");
    const bridge = useMemo(
        () =>
            new ElementWebHostBridge(call, {
                widgetId: call.widget.id,
                widgetRoomId: call.widget.roomId,
                renderPresentation:
                    desktopShell && !useMock
                        ? (presentationBridge) => (
                              <DesktopCallStage client={client} call={call} bridge={presentationBridge} />
                          )
                        : undefined,
            }),
        [call, client, desktopShell, useMock],
    );
    const { intent, config } = call.componentOptions;
    // While Element Call loads, the stage already shows the call rather than a spinner.
    const loading = useMemo(
        () =>
            desktopShell && !useMock ? (
                <DesktopCallStage
                    client={client}
                    call={call}
                    bridge={pendingCallPresentation(call, client.getRoom(call.roomId)?.name ?? call.roomId)}
                />
            ) : (
                <Spinner />
            ),
        [call, client, desktopShell, useMock],
    );
    const generation = useTypedEventEmitterState(call, CallEvent.ComponentRestart, () => call.componentGeneration);

    if (!ElementCall) return loading;

    return (
        <Suspense fallback={loading}>
            <React.Fragment key={generation}>
                <ElementCall
                    client={client}
                    roomId={call.roomId}
                    intent={intent}
                    config={config}
                    hostBridge={bridge}
                    ref={call.setComponentHandle}
                    theme={theme}
                    language={language}
                />
                <MarkReadyOnMount call={call} />
            </React.Fragment>
        </Suspense>
    );
};
