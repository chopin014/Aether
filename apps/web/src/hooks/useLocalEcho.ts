/*
Copyright 2024 New Vector Ltd.
Copyright 2021 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { useLayoutEffect, useRef, useState } from "react";

/**
 * Show a value as changed as soon as someone changes it, while the change is sent.
 * @param currentFactory - Reads the current value.
 * @param setterFn - Sends a change.
 * @param errorFn - Told when sending a change fails. Unless a later change has been made since, the value goes back
 *     to the current one, as it is when the change fails.
 * @param source - What the current value is read from, such as a state event. When it changes, the value is read
 *     again: the room's state may arrive after the view opens, or someone else may change it.
 * @returns The value to show, and a function to change it.
 */
export const useLocalEcho = <T, V extends T = T>(
    currentFactory: () => T,
    setterFn: (value: V) => Promise<unknown>,
    errorFn: (error: unknown) => void,
    source?: unknown,
): [value: T, handler: (value: V) => void] => {
    const [value, setValue] = useState(currentFactory);
    const [readFrom, setReadFrom] = useState(source);
    if (!Object.is(readFrom, source)) {
        setReadFrom(source);
        setValue(currentFactory());
    }
    // A change can fail after the state has moved on, so it goes back to the value read by the latest render.
    const latestFactory = useRef(currentFactory);
    useLayoutEffect(() => {
        latestFactory.current = currentFactory;
    });
    const latestChange = useRef(0);
    const handler = async (value: V): Promise<void> => {
        const change = ++latestChange.current;
        setValue(value);
        try {
            await setterFn(value);
        } catch (e) {
            // A later change is showing what the user chose since, and must not be undone by an older one failing.
            if (change === latestChange.current) setValue(latestFactory.current());
            errorFn(e);
        }
    };

    return [value, handler];
};
