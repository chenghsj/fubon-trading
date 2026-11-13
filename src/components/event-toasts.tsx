import { toast } from 'sonner';
import { Toaster } from './ui/sonner';
// src/components/event-toasts.tsx — order/deal/notice toasts.
// Prominent, kind-coded cards (成交/委託/錯誤/訊息) with clean formatted
// content instead of raw event dumps; size follows the 通知大小 setting.

import {
    BadgeCheck,
    CircleAlert,
    Info,
    Receipt,
} from 'lucide-react';
import { useEffect, useRef } from 'react';
import { describeOrderReport } from '../lib/order-report';
import { playAlert, playDeal, playError, playOrder } from '../lib/sounds';
import { onOrderEvent } from '../lib/stream';
import { useRevealText } from '../lib/privacy-text';
import { useToastScale } from '../lib/toast-prefs';
import { onNotice } from '../lib/trade';
import * as styles from './event-toasts.css';

type ToastKind = 'deal' | 'ok' | 'err' | 'info';

interface ToastItem {
    id: number;
    kind: ToastKind;
    title: string;
    lines: { text: string; dir?: 'up' | 'down' }[];
}

const KIND_ICON: Record<ToastKind, React.ReactNode> = {
    deal: <Receipt size={15} />,
    ok: <BadgeCheck size={15} />,
    err: <CircleAlert size={15} />,
    info: <Info size={15} />,
};

export function EventToasts({ onEvent }: { onEvent?: () => void }) {
    const ids = useRef(new Set<string | number>());
    const nextId = useRef(1);
    const onEventRef = useRef(onEvent);
    onEventRef.current = onEvent;
    const scale = useToastScale();
    useEffect(() => {
        const push = (
            kind: ToastKind,
            title: string,
            lines: ToastItem['lines'],
        ) => {
            const item = { id: nextId.current++, kind, title, lines };
            const id = toast.custom(() => <TradeToast item={item} />, {
                duration: kind === 'err' ? 9000 : 6000,
                onDismiss: item => { ids.current.delete(item.id); },
                onAutoClose: item => { ids.current.delete(item.id); },
            });
            ids.current.add(id);
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
            ids.current.forEach(id => toast.dismiss(id));
            ids.current.clear();
        };
    }, []);

    return <Toaster position="top-right" expand visibleToasts={5} offset={52}
        style={{ width: `${21 * scale}rem` }} />;
}

/** External-store hooks stay mounted inside Sonner so visible cards respond
 * immediately to privacy and scale changes without retaining rendered secrets. */
function TradeToast({ item: t }: { item: ToastItem }) {
    const reveal = useRevealText();
    const scale = useToastScale();
    return <div style={{ fontSize: `${scale}rem`, width: `${21 * scale}rem`, maxWidth: 'calc(100vw - 32px)' }}>
        <div className={styles.toast[t.kind]}>
            <span className={styles.icon[t.kind]}>{KIND_ICON[t.kind]}</span>
            <div className={styles.content}>
                <div className={styles.title}>{reveal(t.title)}</div>
                {t.lines.map((line, i) => <div key={i} className={line.dir ? styles.line[line.dir] : styles.line.plain}>{reveal(line.text)}</div>)}
            </div>
        </div>
    </div>;
}
