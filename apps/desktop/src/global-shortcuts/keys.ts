/*
Copyright 2026 Gabriel

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE in the repository root for full details.
*/

const modifiers = ["Control", "Alt", "Shift", "Meta"];
const namedKeys: Record<string, string> = {
    Space: "space",
    Enter: "Return",
    Escape: "Escape",
    Tab: "Tab",
    Backspace: "BackSpace",
    Delete: "Delete",
    Insert: "Insert",
    Home: "Home",
    End: "End",
    PageUp: "Page_Up",
    PageDown: "Page_Down",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Minus: "minus",
    Equal: "equal",
    BracketLeft: "bracketleft",
    BracketRight: "bracketright",
    Backslash: "backslash",
    Semicolon: "semicolon",
    Quote: "apostrophe",
    Backquote: "grave",
    Comma: "comma",
    Period: "period",
    Slash: "slash",
};
/** Parse a bounded physical-key chord; canonical order also detects duplicate bindings. */
export function parseKey(key: string): { modifiers: string[]; code: string; canonical: string } | undefined {
    if (key.length > 80) return;
    const parts = key.split("+");
    const code = parts.pop()!;
    if (parts.some((part) => !modifiers.includes(part)) || new Set(parts).size !== parts.length) return;
    if (
        !/^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|2[0-4])|Numpad[0-9])$/.test(code) &&
        !(code in namedKeys) &&
        !modifiers.includes(code) &&
        !/^(Control|Alt|Shift|Meta)(Left|Right)$/.test(code)
    )
        return;
    const sorted = modifiers.filter((modifier) => parts.includes(modifier));
    return { modifiers: sorted, code, canonical: [...sorted, code].join("+") };
}
/** Translate physical key names to the XDG shortcuts specification. */
export function portalTrigger(key: string): string | undefined {
    const parsed = parseKey(key);
    if (!parsed) return;
    const { code } = parsed;
    const symbol = code.startsWith("Key")
        ? code.slice(3).toLowerCase()
        : code.startsWith("Digit")
          ? code.slice(5)
          : /^F\d+$/.test(code)
            ? code
            : namedKeys[code];
    if (!symbol) return;
    return [
        ...parsed.modifiers.map((modifier) =>
            modifier === "Control" ? "CTRL" : modifier === "Meta" ? "LOGO" : modifier.toUpperCase(),
        ),
        symbol,
    ].join("+");
}
/** Electron accelerator for reserving a chord, never used as a hold event source. */
export function nativeAccelerator(key: string): string | undefined {
    const parsed = parseKey(key);
    if (!parsed) return;
    const { code } = parsed;
    const special: Record<string, string> = {
        ArrowUp: "Up",
        ArrowDown: "Down",
        ArrowLeft: "Left",
        ArrowRight: "Right",
        Space: "Space",
        Minus: "-",
        Equal: "=",
        BracketLeft: "[",
        BracketRight: "]",
        Backslash: "\\",
        Semicolon: ";",
        Quote: "'",
        Backquote: "`",
        Comma: ",",
        Period: ".",
        Slash: "/",
    };
    if (modifiers.includes(code) || /^(Control|Alt|Shift|Meta)(Left|Right)$/.test(code)) return;
    const symbol = code.startsWith("Key")
        ? code.slice(3)
        : code.startsWith("Digit")
          ? code.slice(5)
          : code.startsWith("Numpad")
            ? `num${code.slice(6)}`
            : (special[code] ?? code);
    return [...parsed.modifiers.map((modifier) => (modifier === "Meta" ? "Super" : modifier)), symbol].join("+");
}
