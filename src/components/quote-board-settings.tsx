import { Popover, PopoverAnchor, PopoverContent } from './ui/popover';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './ui/tabs';
import { useEscClose } from '../hooks/use-esc-close';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
// src/components/quote-board-settings.tsx：報價欄自訂欄位的設定面板（每個 K 線面板各一份）。
// 指數、個股各一組：每一區、每一格可以開關，區塊與格子可以上下移動；面板變窄時照樣依優先度自動收起。
// 畫在錨點所在文件的 body 上：不放進報價欄，免得被階梯量測當成內容，也不會被看板的 overflow 裁掉

import { useCallback, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Info, Lock, RotateCcw, X } from 'lucide-react';
import {
    INDEX_SECTIONS,
    isDefaultLayout,
    moveField,
    moveSection,
    resetKind,
    STOCK_SECTIONS,
    toggleField,
    type BoardKind,
    type KindLayout,
    type QuoteBoardFields,
    type SectionMeta,
} from '../lib/quote-board-fields';
import * as styles from './quote-board-settings.css';

const KIND_LABEL: Record<BoardKind, string> = { index: '指數', stock: '個股・期貨' };

// 錨點：按鈕（右緣對齊按鈕）或右鍵位置（左緣對齊游標）。給了 board 時面板一律放在報價欄下緣之外，
// 邊改邊看得到報價欄的變化，不會蓋住報價欄
export type SettingsAnchor = ({ kind: 'element'; el: HTMLElement } | { kind: 'point'; x: number; y: number; doc: Document }) & {
    board?: HTMLElement;
};

export function QuoteBoardSettings({
    anchor,
    fields,
    currentKind,
    onChange,
    onClose,
}: {
    anchor: SettingsAnchor;
    fields: QuoteBoardFields;
    currentKind: BoardKind;
    onChange: (next: QuoteBoardFields) => void;
    onClose: () => void;
}) {
    const [kind, setKind] = useState<BoardKind>(currentKind);
    const popRef = useRef<HTMLDivElement>(null);
    const doc = anchor.kind === 'element' ? anchor.el.ownerDocument : anchor.doc;

    // 用 X、Esc、點外面關閉時把焦點還給齒輪；用 Tab 離開面板時（非強制對話框）直接關閉，不搶回焦點
    const dismiss = useCallback(() => {
        if (anchor.kind === 'element') anchor.el.focus();
        onClose();
    }, [anchor, onClose]);
    useEscClose(dismiss);
    const virtualAnchor = {
        current: {
            getBoundingClientRect: () => anchor.board?.getBoundingClientRect()
                ?? (anchor.kind === 'element' ? anchor.el.getBoundingClientRect()
                    : { x: anchor.x, y: anchor.y, left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y, width: 0, height: 0, toJSON: () => ({}) }),
        },
    };
    const metas = (kind === 'index' ? INDEX_SECTIONS : STOCK_SECTIONS) as readonly SectionMeta<string, string>[];
    const layout = fields[kind] as KindLayout<string, string>;

    return (
        <Popover open onOpenChange={open => { if (!open) dismiss(); }}>
            <PopoverAnchor virtualRef={virtualAnchor} />
            <PopoverContent ref={popRef} container={doc.body} className={styles.pop} align="end"
                aria-label="報價欄位設定"
                onEscapeKeyDown={event => event.preventDefault()}
                onOpenAutoFocus={event => { event.preventDefault(); popRef.current?.focus(); }}
                onCloseAutoFocus={event => event.preventDefault()}
                onBlur={(e) => {
                    const next = e.relatedTarget as Node | null;
                    if (next && !e.currentTarget.contains(next)) onClose();
                }}
            >
                <div className={styles.head}>
                    <span className={styles.title}>
                        報價欄位
                        <span className={styles.subtitle}>只套用到這個面板，跟版面一起儲存</span>
                    </span>
                    <Button size="compact" variant="ghost" type="button" className={styles.iconBtn} onClick={dismiss} aria-label="關閉" title="關閉">
                        <X size={13} />
                    </Button>
                </div>
                <Tabs value={kind} onValueChange={next => setKind(next as BoardKind)}><TabsList className={styles.segment} aria-label="報價欄種類">
                    {(['index', 'stock'] as const).map((k) => (
                        <TabsTrigger key={k} value={k}
                            title={k === currentKind ? '目前顯示的報價欄' : undefined}
                        >
                            {KIND_LABEL[k]}
                            {k === currentKind && <span className={styles.currentDot} aria-hidden="true" />}
                        </TabsTrigger>
                    ))}
                </TabsList><TabsContent value={kind}>
                {layout.sections.map((sectionId, si) => {
                    const meta = metas.find((m) => m.id === sectionId)!;
                    const order = layout.order[sectionId]!;
                    return (
                        <div key={sectionId} className={styles.section} role="group" aria-label={meta.label}>
                            <div className={styles.sectionHead}>
                                <span className={styles.sectionLabel}>{meta.label}</span>
                                <span className={styles.moves}>
                                    <Button size="compact" variant="outline"
                                        type="button"
                                        className={styles.moveBtn}
                                        disabled={si === 0}
                                        onClick={() => onChange(moveSection(fields, kind, sectionId, -1))}
                                        aria-label={`${meta.label}往前`}
                                        title="整區往前"
                                    >
                                        <ChevronUp size={12} />
                                    </Button>
                                    <Button size="compact" variant="outline"
                                        type="button"
                                        className={styles.moveBtn}
                                        disabled={si === layout.sections.length - 1}
                                        onClick={() => onChange(moveSection(fields, kind, sectionId, 1))}
                                        aria-label={`${meta.label}往後`}
                                        title="整區往後"
                                    >
                                        <ChevronDown size={12} />
                                    </Button>
                                </span>
                            </div>
                            {order.map((fieldId, fi) => {
                                const f = meta.fields.find((m) => m.id === fieldId)!;
                                const on = !layout.hidden.includes(fieldId);
                                const next = order[fi + 1];
                                const nextFixed = meta.fields.find((m) => m.id === next)?.fixed === true;
                                return (
                                    <div key={fieldId} className={styles.row}>
                                        <Label className={styles.check}>
                                            <Checkbox
                                                className={styles.checkbox}
                                                checked={on}
                                                onCheckedChange={() => onChange(toggleField(fields, kind, fieldId))}
                                            />
                                            <span className={on ? styles.fieldLabel : `${styles.fieldLabel} ${styles.fieldOff}`}>{f.label}</span>
                                            {f.hint && <span className={styles.hint}>{f.hint}</span>}
                                        </Label>
                                        <span className={styles.moves}>
                                            {f.fixed ? (
                                                <span className={styles.pinned} title="位置固定">
                                                    <Lock size={10} aria-hidden="true" />
                                                </span>
                                            ) : (
                                                <>
                                                    <Button size="compact" variant="outline"
                                                        type="button"
                                                        className={styles.moveBtn}
                                                        disabled={fi === 0}
                                                        onClick={() => onChange(moveField(fields, kind, fieldId, -1))}
                                                        aria-label={`${f.label}往前`}
                                                        title="往前"
                                                    >
                                                        <ChevronUp size={12} />
                                                    </Button>
                                                    <Button size="compact" variant="outline"
                                                        type="button"
                                                        className={styles.moveBtn}
                                                        disabled={next === undefined || nextFixed}
                                                        onClick={() => onChange(moveField(fields, kind, fieldId, 1))}
                                                        aria-label={`${f.label}往後`}
                                                        title="往後"
                                                    >
                                                        <ChevronDown size={12} />
                                                    </Button>
                                                </>
                                            )}
                                        </span>
                                    </div>
                                );
                            })}
                        </div>
                    );
                })}
                </TabsContent></Tabs>
                <div className={styles.foot}>
                    <span className={styles.footNote}>
                        <Info size={11} aria-hidden="true" />
                        面板變窄時，仍會依序收起次要的格子
                    </span>
                    <Button size="compact" variant="ghost"
                        type="button"
                        className={styles.reset}
                        disabled={isDefaultLayout(fields, kind)}
                        onClick={() => onChange(resetKind(fields, kind))}
                        title={`${KIND_LABEL[kind]}報價欄恢復預設`}
                    >
                        <RotateCcw size={11} />
                        恢復預設
                    </Button>
                </div>
            </PopoverContent>
        </Popover>
    );
}
