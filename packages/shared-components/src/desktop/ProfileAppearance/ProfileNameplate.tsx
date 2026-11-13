/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import React, { type CSSProperties, type JSX, type RefObject, useEffect, useRef, useState } from "react";

import { ArtCanvas } from "./art/ArtCanvas";
import { NAMEPLATE_SCENES } from "./art/nameplateScenes";
import { PROFILE_NAMEPLATE_PALETTES, type ProfileNameplateValue } from "./profileCatalogue";
import { useImageColour } from "./profilePalette";
import { useProfileLive } from "./useProfileMotion";
import styles from "./ProfileArt.module.css";

/** Space kept clear after the text before the artwork reaches full strength, as Discord measures it. */
const TEXT_GAP = 10;

/**
 * Where the row's text ends, in pixels from the row's start, so the artwork can stay faint behind it. Follows the
 * text as names, statuses and the row's width change.
 */
function useTextEnd(plate: RefObject<HTMLElement | null>, text?: RefObject<HTMLElement | null>): number | undefined {
    const [end, setEnd] = useState<number>();
    // A passive effect, not a layout one: the nameplate is drawn before the row's text, so the text's ref is only
    // attached once every layout effect has run.
    useEffect(() => {
        const plateElement = plate.current;
        const textElement = text?.current;
        if (!plateElement || !textElement) return;
        const measure = (): void => {
            const plateBox = plateElement.getBoundingClientRect();
            const textBox = textElement.getBoundingClientRect();
            const rtl = getComputedStyle(plateElement).direction === "rtl";
            const value = rtl ? plateBox.right - textBox.left : textBox.right - plateBox.left;
            setEnd(Math.max(0, Math.round(value + TEXT_GAP)));
        };
        measure();
        if (typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(measure);
        observer.observe(plateElement);
        observer.observe(textElement);
        return () => observer.disconnect();
    }, [plate, text]);
    return end;
}

/** A person's own nameplate image: the still version at rest, with the original laid over it once it has loaded. */
function NameplateImage({
    imageUrl,
    animatedUrl,
    live,
}: {
    imageUrl: string;
    animatedUrl?: string;
    live: boolean;
}): JSX.Element {
    const [ready, setReady] = useState(false);
    const playing = live && animatedUrl;
    return (
        <>
            <img className={styles.nameplateArt} src={imageUrl} alt="" loading="lazy" />
            {playing && (
                <img
                    className={styles.nameplateArt}
                    data-ready={ready}
                    src={animatedUrl}
                    alt=""
                    onLoad={() => setReady(true)}
                />
            )}
        </>
    );
}

/** Properties for {@link ProfileNameplate}. */
export interface ProfileNameplateProps {
    nameplate: ProfileNameplateValue;
    /** The row is hovered, focused or selected, so the artwork moves. Follows the surrounding surface when omitted. */
    live?: boolean;
    /** The row is selected, which deepens its tint. */
    selected?: boolean;
    /** The row's text. The artwork stays faint behind it and reaches full strength just after it. */
    textRef?: RefObject<HTMLElement | null>;
}

/**
 * The artwork behind a name, drawn the way Discord draws nameplates: the row is tinted with the nameplate's colour,
 * the scene sits against the row's far edge, and it stays faint behind the text so the name always reads.
 */
export function ProfileNameplate({
    nameplate,
    live: liveProp,
    selected = false,
    textRef,
}: ProfileNameplateProps): JSX.Element {
    const surfaceLive = useProfileLive();
    const live = liveProp ?? surfaceLive;
    const plate = useRef<HTMLDivElement>(null);
    const textEnd = useTextEnd(plate, textRef);
    const imageColour = useImageColour("imageUrl" in nameplate ? nameplate.imageUrl : undefined);
    const palette = "preset" in nameplate ? PROFILE_NAMEPLATE_PALETTES[nameplate.preset] : imageColour;
    const style = {
        ...(palette ? { "--plate": palette } : {}),
        ...(textEnd !== undefined ? { "--plate-text-end": `${textEnd}px` } : {}),
    } as CSSProperties;
    return (
        <div
            ref={plate}
            className={styles.nameplate}
            data-nameplate={"preset" in nameplate ? nameplate.preset : "image"}
            data-live={live}
            data-selected={selected}
            style={style}
            aria-hidden="true"
        >
            {"preset" in nameplate ? (
                <ArtCanvas className={styles.nameplateArt} scene={NAMEPLATE_SCENES[nameplate.preset]} live={live} />
            ) : (
                <NameplateImage imageUrl={nameplate.imageUrl} animatedUrl={nameplate.animatedUrl} live={live} />
            )}
        </div>
    );
}
