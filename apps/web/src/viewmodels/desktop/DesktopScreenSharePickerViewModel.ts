/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import {
    BaseViewModel,
    type DesktopScreenSharePickerViewModel as DesktopScreenSharePickerViewModelContract,
    type DesktopScreenSharePickerViewSnapshot,
    type DesktopCallStageQualityState,
} from "@element-hq/web-shared-components";

import { DesktopVoicePipeline } from "../../audio/desktop/DesktopVoicePipeline";
import { getScreenSharePolicyLimits, resolveScreenShareQuality } from "../../audio/desktop/ScreenShareQuality";

interface Props {
    getSources: () => Promise<DesktopCapturerSource[]>;
    onFinished: (source?: DesktopCapturerSource) => void;
}

/** Owns source refresh, cancellation, confirmation, and deployment-bounded sharing preferences. */
export class DesktopScreenSharePickerViewModel
    extends BaseViewModel<DesktopScreenSharePickerViewSnapshot, Props>
    implements DesktopScreenSharePickerViewModelContract
{
    private timer?: ReturnType<typeof setTimeout>;
    private pending?: Promise<void>;
    private finished = false;
    private confirming = false;

    public constructor(props: Props) {
        super(props, {
            step: "source",
            tab: "window",
            sources: [],
            selectedSource: null,
            loading: true,
            error: null,
            quality: { ...DesktopVoicePipeline.instance.getScreenShareQuality(), includeSystemAudio: false },
            limits: getScreenSharePolicyLimits(),
        });
        this.disposables.track(() => clearTimeout(this.timer));
        void this.poll();
    }

    private async poll(): Promise<void> {
        await this.refresh();
        if (!this.isDisposed && !this.finished) this.timer = setTimeout(() => void this.poll(), 500);
    }

    /** Refresh serially so an old thumbnail response cannot restore a removed source. */
    public refresh = (): Promise<void> => {
        if (this.isDisposed || this.finished) return Promise.resolve();
        this.pending ??= this.fetchSources().finally(() => {
            this.pending = undefined;
        });
        return this.pending;
    };

    private async fetchSources(): Promise<void> {
        try {
            const sources = await this.props.getSources();
            if (this.isDisposed || this.finished) return;
            const selectedSource =
                sources.find((source) => source.id === this.snapshot.current.selectedSource?.id) ?? null;
            this.snapshot.merge({
                sources,
                selectedSource,
                loading: false,
                error: null,
                ...(selectedSource === null ? { step: "source" as const } : {}),
            });
        } catch (error) {
            if (this.isDisposed || this.finished) return;
            this.snapshot.merge({
                loading: false,
                selectedSource: null,
                sources: [],
                step: "source",
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    public selectTab = (tab: "screen" | "window"): void => {
        if (tab !== this.snapshot.current.tab) this.snapshot.merge({ tab, selectedSource: null });
    };

    public selectSource = (id: string): void => {
        const selectedSource = this.snapshot.current.sources.find((source) => source.id === id);
        if (selectedSource && id.startsWith(this.snapshot.current.tab)) this.snapshot.merge({ selectedSource });
    };

    public setQuality = (patch: Partial<DesktopCallStageQualityState>): void => {
        const quality = resolveScreenShareQuality({
            ...this.snapshot.current.quality,
            ...patch,
            includeSystemAudio: false,
        });
        this.snapshot.merge({ quality });
    };

    public next = (): void => {
        if (this.snapshot.current.selectedSource) this.snapshot.merge({ step: "quality" });
    };

    public back = (): void => {
        this.snapshot.merge({ step: "source" });
    };

    public confirm = (): void => {
        if (this.confirming || this.finished || this.isDisposed || this.snapshot.current.step !== "quality") return;
        this.confirming = true;
        void this.confirmCurrentSource();
    };

    private async confirmCurrentSource(): Promise<void> {
        try {
            const selectedId = this.snapshot.current.selectedSource?.id;
            await this.refresh();
            if (
                this.isDisposed ||
                this.finished ||
                !selectedId ||
                this.snapshot.current.selectedSource?.id !== selectedId
            )
                return;
            this.finished = true;
            clearTimeout(this.timer);
            DesktopVoicePipeline.instance.setScreenShareQuality(this.snapshot.current.quality);
            this.props.onFinished(this.snapshot.current.selectedSource);
        } finally {
            this.confirming = false;
        }
    }

    public cancel = (): void => {
        if (this.finished || this.isDisposed) return;
        this.finished = true;
        clearTimeout(this.timer);
        this.props.onFinished();
    };
}
