/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

// @vitest-environment happy-dom

import React from "react";
import { render } from "test-utils-rtl";
import { describe, expect, it, vi } from "vitest";
import { type MatrixClient } from "matrix-js-sdk/src/matrix";

import { stubClient } from "test-utils";
import { CreateServerDialog } from "./CreateServerDialog";

const clients = vi.hoisted(() => [] as (MatrixClient | null)[]);
vi.mock("../../../viewmodels/desktop/CreateServerViewModel", async (importOriginal) => {
    const { CreateServerViewModel } =
        await importOriginal<typeof import("../../../viewmodels/desktop/CreateServerViewModel")>();
    return {
        CreateServerViewModel: class extends CreateServerViewModel {
            public constructor(props: ConstructorParameters<typeof CreateServerViewModel>[0]) {
                clients.push(props.client);
                super(props);
            }
        },
    };
});

describe("CreateServerDialog", () => {
    it("creates servers with the signed-in client when opened as a modal, outside the client context", () => {
        const client = stubClient();
        render(<CreateServerDialog onFinished={vi.fn()} />);
        expect(clients).toEqual([client]);
    });
});
