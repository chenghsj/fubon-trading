import { useRef, type ComponentProps, type ReactNode } from 'react';
import { useEscClose } from '../hooks/use-esc-close';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';

interface TerminalDialogProps extends Omit<ComponentProps<typeof DialogContent>, 'title' | 'onOpenChange'> {
    title: string;
    onClose: () => void;
    open?: boolean;
    locked?: boolean;
    children: ReactNode;
    canClose?: () => boolean;
    onEscapeClose?: () => void;
}

/** Trading dialogs share the modal stack so Escape never arms cancel-all.
 * Radix owns portals, focus containment, outside dismissal and focus return. */
export function TerminalDialog({ open = true, ...props }: TerminalDialogProps) {
    return open ? <OpenTerminalDialog {...props} /> : null;
}

function OpenTerminalDialog({ title, onClose, locked, canClose, onEscapeClose, children, ...props }: Omit<TerminalDialogProps, 'open'>) {
    const opener = useRef(typeof document !== 'undefined' ? document.activeElement as HTMLElement | null : null);
    const close = () => { if (!locked && (canClose?.() ?? true)) onClose(); };
    useEscClose(onEscapeClose ?? close);
    return <Dialog open onOpenChange={next => { if (!next) close(); }}>
        <DialogContent layout="terminal" showCloseButton={false} aria-describedby={undefined}
            {...props}
            onCloseAutoFocus={event => {
                props.onCloseAutoFocus?.(event);
                if (!event.defaultPrevented && opener.current?.isConnected) {
                    event.preventDefault();
                    opener.current.focus();
                }
            }}
            onEscapeKeyDown={event => event.preventDefault()}
            onInteractOutside={event => { if (locked || !(canClose?.() ?? true)) event.preventDefault(); }}>
            <DialogTitle className="sr-only">{title}</DialogTitle>
            {children}
        </DialogContent>
    </Dialog>;
}
