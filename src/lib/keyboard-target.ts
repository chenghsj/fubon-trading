/** Keyboard-operable form controls keep their own keys, including Radix
 * controls whose host is a button or span instead of a native input. */
export function isFormControlTarget(target: EventTarget | null): boolean {
    const element = target as HTMLElement | null;
    return !!element && (
        ['INPUT', 'TEXTAREA', 'SELECT', 'LABEL'].includes(element.tagName) ||
        element.isContentEditable === true ||
        !!element.closest?.('input, textarea, select, label, [contenteditable="true"], [role="checkbox"], [role="radio"], [role="slider"], [role="switch"], [role="tablist"], [role="menu"], [role="radiogroup"]')
    );
}
