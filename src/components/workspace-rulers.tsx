import { useEffect, useMemo, useRef, type KeyboardEvent, type PointerEvent, type ReactNode, type Ref } from 'react';
import type { Layout } from 'react-grid-layout';
import { bottom } from 'react-grid-layout/core';
import { Check, SlidersHorizontal } from 'lucide-react';
import * as RadioGroupPrimitive from '@radix-ui/react-radio-group';
import { gridDensity } from '../lib/workspace-grid';
import { gridColumnStep, gridRowStep, rulerHandleGroups, rulerPixel, rulerSteps, RULER_PRECISIONS, RULER_PRECISION_LABELS, type RulerAxis, type RulerPrecision } from '../lib/workspace-ruler';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { RadioGroup } from './ui/radio-group';
import { Button } from './ui/button';
import * as styles from './workspace-rulers.css';

interface WorkspaceRulersProps {
    layout: Layout;
    width: number;
    cols: number;
    enabled: boolean;
    precision: RulerPrecision;
    onPrecisionChange: (precision: RulerPrecision) => void;
    steps: Record<RulerAxis, number>;
    unit: number;
    hitSize: number;
    active: { axis: RulerAxis; position: number; positions: readonly number[]; delta: number } | null;
    onStart: (axis: RulerAxis, position: number) => boolean;
    onMove: (delta: number) => void;
    onStop: (cancel?: boolean) => void;
    containerRef: Ref<HTMLDivElement>;
    children: ReactNode;
}

interface PointerFrame {
    id: number;
    axis: RulerAxis;
    start: number;
    client: number;
    step: number;
    scrollTop: number;
    host: HTMLElement | null;
    target: HTMLElement;
}

export function WorkspaceRulers(props: WorkspaceRulersProps) {
    const surface = useRef<HTMLDivElement>(null);
    const pointer = useRef<PointerFrame | null>(null);
    const latest = useRef(props);
    latest.current = props;
    const columnStep = gridColumnStep(props.width, props.cols);
    const boundaries = useMemo(() => ({
        x: rulerHandleGroups(props.layout, 'x', props.cols, props.unit, columnStep, props.hitSize),
        y: rulerHandleGroups(props.layout, 'y', props.cols, props.unit, gridRowStep, props.hitSize),
    }), [props.layout, props.cols, props.unit, props.hitSize, columnStep]);
    const rows = bottom(props.layout);
    const height = rulerPixel(rows, gridRowStep) + 3;
    const previewPointer = () => {
        const frame = pointer.current;
        if (!frame) return;
        const scroll = frame.axis === 'y' ? (frame.host?.scrollTop ?? 0) - frame.scrollTop : 0;
        latest.current.onMove((frame.client - frame.start + scroll) / frame.step);
    };
    const finishPointer = (cancel: boolean) => {
        const frame = pointer.current;
        if (!frame) return;
        pointer.current = null;
        if (frame.target.hasPointerCapture(frame.id)) frame.target.releasePointerCapture(frame.id);
        latest.current.onStop(cancel);
    };
    // Keep the listener identity stable for pointer cleanup across preview renders.
    const scrollListener = useRef(() => {});
    scrollListener.current = previewPointer;
    const onScroll = useRef(() => scrollListener.current()).current;
    const endPointer = (cancel: boolean) => {
        pointer.current?.host?.removeEventListener('scroll', onScroll);
        finishPointer(cancel);
    };
    const endRef = useRef(endPointer);
    endRef.current = endPointer;
    useEffect(() => {
        const escape = (event: globalThis.KeyboardEvent) => {
            if (event.key !== 'Escape' || !pointer.current) return;
            event.preventDefault();
            event.stopPropagation();
            endRef.current(true);
        };
        const blur = () => endRef.current(true);
        window.addEventListener('keydown', escape, true);
        window.addEventListener('blur', blur);
        return () => {
            window.removeEventListener('keydown', escape, true);
            window.removeEventListener('blur', blur);
            endRef.current(true);
        };
    }, []);
    useEffect(() => {
        if (!props.active) endRef.current(true);
    }, [props.active]);

    const startPointer = (event: PointerEvent<HTMLDivElement>, axis: RulerAxis, position: number) => {
        if (event.button !== 0 || pointer.current || !props.enabled || !props.onStart(axis, position)) return;
        event.preventDefault();
        const client = axis === 'x' ? event.clientX : event.clientY;
        const host = surface.current?.parentElement ?? null;
        pointer.current = { id: event.pointerId, axis, start: client, client,
            step: axis === 'x' ? columnStep : gridRowStep, host, scrollTop: host?.scrollTop ?? 0, target: event.currentTarget };
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        host?.addEventListener('scroll', onScroll);
    };
    const keyResize = (event: KeyboardEvent, axis: RulerAxis, position: number) => {
        const negative = axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
        const positive = axis === 'x' ? 'ArrowRight' : 'ArrowDown';
        if (![negative, positive].includes(event.key) || pointer.current || !props.enabled) return;
        event.preventDefault();
        event.stopPropagation();
        if (!props.onStart(axis, position)) return;
        props.onMove((event.key === negative ? -1 : 1) * (event.shiftKey ? 5 : 1) * props.steps[axis]);
        props.onStop();
    };
    const rail = (axis: RulerAxis) => {
        const horizontal = axis === 'x';
        const step = horizontal ? columnStep : gridRowStep;
        const extent = horizontal ? props.cols : rows;
        const increment = props.steps[axis];
        const major = horizontal ? 4 : Math.round(2 / increment);
        return <div className={horizontal ? styles.horizontal : styles.vertical} aria-label={horizontal ? '欄寬尺標' : '列高尺標'}>
            {Array.from({ length: Math.floor(extent / increment) + 1 }, (_, index) => <span key={`tick-${index}`} aria-hidden="true"
                className={styles.tick} data-major={index % major === 0}
                data-edge={index === 0 ? 'start' : index * increment === extent ? 'end' : undefined}
                style={horizontal ? { left: rulerPixel(index * increment, step) } : { top: rulerPixel(index * increment, step) }}>
                {index % major === 0 && <span>{horizontal ? Math.round(index * increment / props.cols * 100) : index * increment}</span>}
            </span>)}
            {boundaries[axis].map((boundary, index) => {
                const active = props.active?.axis === axis && props.active.position === boundary.position;
                const position = boundary.position + (active ? props.active!.delta : 0);
                const disabled = !props.enabled || boundary.min >= boundary.max;
                return <div key={`edge-${index}`} role="separator" tabIndex={disabled ? -1 : 0}
                    aria-label={`${horizontal ? '整欄' : '整列'}分界 ${index + 1}`}
                    aria-orientation={horizontal ? 'vertical' : 'horizontal'} aria-disabled={disabled}
                    aria-valuemin={boundary.min} aria-valuemax={Number.isFinite(boundary.max) ? boundary.max : Number.MAX_SAFE_INTEGER}
                    aria-valuenow={position} aria-valuetext={`${boundary.positions.length > 1 ? `連動 ${boundary.positions.length} 條邊界，` : ''}${horizontal ? `${Math.round(position / props.cols * 100)}%` : `${Math.round(position * gridRowStep)} 像素`}`}
                    title={`拖曳調整${horizontal ? '整欄寬度' : '整列高度'}${boundary.positions.length > 1 ? `（連動 ${boundary.positions.length} 條相近邊界）` : ''}；方向鍵微調，Esc 取消`}
                    className={styles.handle} data-active={active} data-axis={axis} data-grouped={boundary.positions.length > 1}
                    style={horizontal ? { left: rulerPixel(position, step) } : { top: rulerPixel(position, step) }}
                    onPointerDown={event => startPointer(event, axis, boundary.position)}
                    onPointerMove={event => {
                        const frame = pointer.current;
                        if (!frame || frame.id !== event.pointerId) return;
                        frame.client = frame.axis === 'x' ? event.clientX : event.clientY;
                        previewPointer();
                    }}
                    onPointerUp={event => {
                        if (pointer.current?.id !== event.pointerId) return;
                        pointer.current.client = axis === 'x' ? event.clientX : event.clientY;
                        previewPointer();
                        endPointer(false);
                    }}
                    onPointerCancel={event => { if (pointer.current?.id === event.pointerId) endPointer(true); }}
                    onLostPointerCapture={event => { if (pointer.current?.id === event.pointerId) endPointer(true); }}
                    onKeyDown={event => keyResize(event, axis, boundary.position)}><span /></div>;
            })}
        </div>;
    };
    return <div ref={surface} className={styles.surface} data-ruler-dragging={props.active?.axis}>
        <Popover>
            <PopoverTrigger asChild>
                <Button size="compact-icon" variant="ghost" className={styles.corner} aria-label="尺標精細度" title={`尺標精細度：${RULER_PRECISION_LABELS[props.precision]}`}
                    disabled={!props.enabled || !!props.active}><SlidersHorizontal size={14} aria-hidden="true" /></Button>
            </PopoverTrigger>
            <PopoverContent align="start" side="bottom" aria-label="尺標精細度設定" className={styles.precisionPanel}>
                <p className={styles.precisionTitle}>拖曳精細度</p>
                <RadioGroup className={styles.precisionOptions} aria-label="拖曳精細度" value={props.precision} onValueChange={value => {
                    if (RULER_PRECISIONS.includes(value as RulerPrecision)) props.onPrecisionChange(value as RulerPrecision);
                }}>
                    {RULER_PRECISIONS.map(value => {
                        const steps = rulerSteps(value, props.cols / 24, gridDensity(props.width));
                        return <RadioGroupPrimitive.Item key={value} value={value} className={styles.precisionOption}
                            aria-label={RULER_PRECISION_LABELS[value]} disabled={!props.enabled || !!props.active}>
                            <span className={styles.precisionOptionCopy}>
                                <span>{RULER_PRECISION_LABELS[value]}</span>
                                <small>橫向 {Math.round(steps.x * columnStep)} px · 縱向 {steps.y * gridRowStep} px</small>
                            </span>
                            <span className={styles.precisionCheck} aria-hidden="true">
                                <RadioGroupPrimitive.Indicator><Check size={15} strokeWidth={2} /></RadioGroupPrimitive.Indicator>
                            </span>
                        </RadioGroupPrimitive.Item>;
                    })}
                </RadioGroup>
                <p className={styles.precisionHint}>拖曳與方向鍵會依所選間距調整，已細調的位置會保留。</p>
            </PopoverContent>
        </Popover>
        {rail('x')}
        <div className={styles.verticalTrack} style={{ minHeight: height }}>{rail('y')}</div>
        <div ref={props.containerRef} className={styles.content}>
            {props.children}
            {props.active && <div aria-hidden="true" className={styles.guide} data-axis={props.active.axis} data-grouped={props.active.positions.length > 1}
                style={props.active.axis === 'x'
                    ? { left: rulerPixel(props.active.positions[0]! + props.active.delta, columnStep), width: (props.active.positions.at(-1)! - props.active.positions[0]!) * columnStep }
                    : { top: rulerPixel(props.active.positions[0]! + props.active.delta, gridRowStep), height: (props.active.positions.at(-1)! - props.active.positions[0]!) * gridRowStep }} />}
        </div>
    </div>;
}
