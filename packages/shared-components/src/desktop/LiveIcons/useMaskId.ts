/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

import { useId } from "react";

/** A document-unique id for an icon's SVG mask. React's ids contain characters that would need escaping in url(). */
export function useMaskId(prefix: string): string {
    return `${prefix}-${useId().replace(/[^\w-]/g, "")}`;
}
