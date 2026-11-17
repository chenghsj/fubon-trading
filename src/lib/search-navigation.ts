/** Keyboard result navigation. Call only after checking IME composition. */
export function searchNavigationDirection(event: {
    key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean;
}): -1 | 0 | 1 {
    if (event.key === 'ArrowDown') return 1;
    if (event.key === 'ArrowUp') return -1;
    if (event.ctrlKey && !event.metaKey && !event.altKey) {
        if (event.key.toLowerCase() === 'n') return 1;
        if (event.key.toLowerCase() === 'p') return -1;
    }
    return 0;
}
