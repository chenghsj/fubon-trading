import { toast } from 'sonner';
import { Toaster } from './ui/sonner';
// src/components/event-toasts.tsx — order/deal/notice toasts.
// Native Sonner title/description slots keep notices compact and consistent
// with the shared shadcn surface; text remains reactive to privacy settings.

import {
    BadgeCheck,
    CircleAlert,
    Info,
    Receipt,
} from 'lucide-react';
import { useEffect, useRef, type CSSProperties } from 'react';
import { describeOrderReport } from '../lib/order-report';
import { playAlert, playDeal, playError, playOrder } from '../lib/sounds';
import { onOrderEvent } from '../lib/stream';
import { useRevealText } from '../lib/privacy-text';
import { useToastScale } from '../lib/toast-prefs';
import { onNotice } from '../lib/trade';
import * as styles from './event-toasts.css';

type ToastKind = 'deal' | 'ok' | 'err' | 'info';

type ToastLines = { text: string; dir?: 'up' | 'down' }[];
type VisibleToast = { kind: ToastKind; title: string; lines: ToastLines };

const KIND_ICON: Record<ToastKind, React.ReactNode> = {
    deal: <Receipt size={15} />,
    ok: <BadgeCheck size={15} />,
    err: <CircleAlert size={15} />,
    info: <Info size={15} />,
};

export function EventToasts({ onEvent }: { onEvent?: () => void }) {
    const items = useRef(new Map<string | number, VisibleToast>());
    const onEventRef = useRef(onEvent);
    onEventRef.current = onEvent;
    const scale = useToastScale();
    useEffect(() => {
        const push = (
            kind: ToastKind,
            title: string,
            lines: ToastLines,
        ) => {
            const show = kind === 'err' ? toast.error : kind === 'info' ? toast.info : toast.success;
            const id = show(<ToastTitle text={title} />, {
                description: lines.length > 0 ? <ToastDescription lines={lines} /> : undefined,
                icon: KIND_ICON[kind],
                classNames: {
                    toast: styles.toast,
                    icon: styles.icon[kind],
                    content: styles.content,
                    title: styles.title,
                    description: styles.description,
                    closeButton: styles.closeButton,
                },
                duration: kind === 'err' ? 9000 : 6000,
                onDismiss: item => { items.current.delete(item.id); },
                onAutoClose: item => { items.current.delete(item.id); },
            });
            items.current.set(id, { kind, title, lines });
        };
        const offOrder = onOrderEvent((ev) => {
            const d = describeOrderReport(ev);
            push(d.kind, d.title, d.lines);
            if (d.kind === 'deal') playDeal();
            else if (d.kind === 'err') playError();
            else playOrder();
            onEventRef.current?.();
        });
        const offNotice = onNotice((n) => {
            const kind: ToastKind =
                n.kind === 'err' ? 'err' : n.kind === 'ok' ? 'ok' : 'info';
            push(kind, n.title, n.body ? [{ text: n.body }] : []);
            if (n.kind === 'err') playError();
            else if (n.title.includes('警示')) playAlert();
            else if (n.kind === 'ok') playOrder();
            if (n.kind === 'ok') onEventRef.current?.();
        });
        return () => {
            offOrder();
            offNotice();
            items.current.forEach((_item, id) => toast.dismiss(id));
            items.current.clear();
        };
    }, []);

    useEffect(() => {
        // Native Sonner remeasures when its content props change. Refresh the
        // existing IDs after reflow so multi-line toasts do not overlap.
        const reflow = () => items.current.forEach((item, id) => {
            const show = item.kind === 'err' ? toast.error : item.kind === 'info' ? toast.info : toast.success;
            show(<ToastTitle text={item.title} />, {
                id,
                description: item.lines.length > 0 ? <ToastDescription lines={item.lines} /> : undefined,
            });
        });
        reflow();
        if (typeof window === 'undefined') return;
        window.addEventListener('resize', reflow);
        return () => window.removeEventListener('resize', reflow);
    }, [scale]);

    return <Toaster position="top-right" expand closeButton visibleToasts={5} gap={8}
        offset={{ top: 64, right: 16 }}
        mobileOffset={{ top: 64, right: 12, left: 12, bottom: 16 }}
        style={{ '--width': `${19 * scale}rem`, '--event-toast-scale': scale } as CSSProperties} />;
}

/** Keep these hooks inside the visible Sonner slots so toggling privacy also
 * masks notifications that were already on screen. */
function ToastTitle({ text }: { text: string }) {
    const reveal = useRevealText();
    return <>{reveal(text)}</>;
}

function ToastDescription({ lines }: { lines: ToastLines }) {
    const reveal = useRevealText();
    return <>{lines.map((line, i) => (
        <div key={i} className={styles.line[line.dir ?? 'plain']}>{reveal(line.text)}</div>
    ))}</>;
}
