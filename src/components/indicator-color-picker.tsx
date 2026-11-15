import { useEffect, useId, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { useEscClose } from '../hooks/use-esc-close';
import { MA_PRESETS } from '../lib/ma-presets';
import * as styles from './indicator-color-picker.css';

function hslHex(h: number, s: number, l: number): string {
    const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
    const f = (n: number) => {
        const k = (n + h / 30) % 12;
        const c = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
        return Math.round(255 * c).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
}
const HUES = [0, 25, 48, 95, 150, 178, 210, 245, 280, 330];
export const COLOR_GRID: string[][] = [
    [100, 95, 85, 70, 55, 40, 30, 20, 10, 0].map(l => hslHex(0, 0, l)),
    HUES.map(h => hslHex(h, 82, 58)),
    ...[84, 74, 64, 50, 38, 28].map(l => HUES.map(h => hslHex(h, 62, l))),
];
const COLORS = COLOR_GRID.flat();

export function IndicatorColorPalette({ color, onChange, onSelect }: {
    color: string; onChange: (color: string) => void; onSelect?: () => void;
}) {
    const hexId = useId();
    const [hex, setHex] = useState(color.toUpperCase());
    useEffect(() => setHex(color.toUpperCase()), [color]);
    const valid = /^#[0-9a-f]{6}$/i.test(hex);
    const choose = (next: string) => { onChange(next); onSelect?.(); };
    const selected = COLORS.findIndex(value => value.toLowerCase() === color.toLowerCase());
    const swatch = (value: string) => <>
        {value.toLowerCase() === color.toLowerCase() && <span className={styles.selectedMark}><Check size={10} strokeWidth={3} /></span>}
    </>;
    return <div className={styles.palette}>
        <div className={styles.caption}>常用色</div>
        <div className={styles.quickColors}>
            {MA_PRESETS.map(({ color: value }) => <Button key={value} size="compact-icon" variant="ghost"
                className={styles.swatch} style={{ background: value }} aria-label={`常用色 ${value.toUpperCase()}`}
                aria-pressed={value.toLowerCase() === color.toLowerCase()} onClick={() => choose(value)}>{swatch(value)}</Button>)}
        </div>
        <div className={styles.grid} role="radiogroup" aria-label="顏色色票" onKeyDown={event => {
            const keys: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 10, ArrowUp: -10 };
            if (!(event.key in keys) && event.key !== 'Home' && event.key !== 'End') return;
            const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
            const current = buttons.findIndex(button => button === document.activeElement);
            if (current < 0) return;
            event.preventDefault();
            const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + keys[event.key]! + buttons.length) % buttons.length;
            buttons[index]?.focus();
            onChange(COLORS[index]!);
        }}>
            {COLORS.map((value, index) => <Button key={index} size="compact-icon" variant="ghost" role="radio"
                className={styles.swatch} style={{ background: value }} aria-label={`顏色 ${value.toUpperCase()}`}
                aria-checked={index === selected} tabIndex={index === (selected < 0 ? 0 : selected) ? 0 : -1}
                onClick={() => choose(value)}>{swatch(value)}</Button>)}
        </div>
        <Label htmlFor={hexId} className={styles.caption}>自訂色碼</Label>
        <div className={styles.hexRow}>
            <span className={styles.hexPreview} style={{ background: color }} aria-hidden="true" />
            <Input id={hexId} className={styles.hexInput} value={hex} maxLength={7} spellCheck={false} autoComplete="off"
                aria-invalid={!valid} onChange={event => setHex(event.target.value.trim())}
                onKeyDown={event => { if (event.key === 'Enter' && valid) { event.preventDefault(); choose(hex.toLowerCase()); } }} />
            <Button size="compact" variant="outline" aria-label="套用色碼" disabled={!valid} onClick={() => choose(hex.toLowerCase())}>套用</Button>
        </div>
    </div>;
}

export function IndicatorColorPicker({ color, label, onChange }: { color: string; label: string; onChange: (color: string) => void }) {
    const [open, setOpen] = useState(false);
    useEscClose(() => setOpen(false), open);
    return <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
            <Button size="compact" variant="outline" className={styles.trigger} aria-label={label} title={`${label} · ${color.toUpperCase()}`}>
                <span className={styles.line} style={{ background: color }} aria-hidden="true" />
                <ChevronDown size={12} aria-hidden="true" />
            </Button>
        </PopoverTrigger>
        <PopoverContent align="end" collisionPadding={12} className={styles.popover} aria-label={`選擇${label}`}
            onEscapeKeyDown={event => event.preventDefault()}>
            <IndicatorColorPalette color={color} onChange={onChange} onSelect={() => setOpen(false)} />
        </PopoverContent>
    </Popover>;
}
