/** Result navigation across input methods; active composition belongs to the IME. */
export function searchNavigationDirection(event: {
    key: string; code?: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean;
    keyCode?: number; isComposing?: boolean;
}, composing = false): -1 | 0 | 1 {
    if (composing || event.isComposing) return 0;
    if (event.ctrlKey && !event.metaKey && !event.altKey) {
        // IMEs can replace key with Process/a phonetic character and report 229
        // even outside composition. The physical key still identifies Ctrl+N/P.
        if (event.code === 'KeyN' || event.key.toLowerCase() === 'n') return 1;
        if (event.code === 'KeyP' || event.key.toLowerCase() === 'p') return -1;
    }
    if (event.keyCode === 229) return 0;
    if (event.key === 'ArrowDown') return 1;
    if (event.key === 'ArrowUp') return -1;
    return 0;
}
