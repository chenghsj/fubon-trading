import { useId, useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
// src/components/custom-theme-editor.tsx — 外觀設定「自訂」主題的編輯區：
// 預設組合、六個顏色與即時預覽。

import {
    CUSTOM_BASES,
    CUSTOM_COLOR_FIELDS,
    CUSTOM_PRESETS,
    type CustomBase,
    type CustomTheme,
} from '../lib/custom-theme';
import { setThemeSettings, useThemeSettings } from '../lib/theme-store';
import * as hud from './hud-header.css';
import * as panel from './panel.css';
import * as styles from './custom-theme-editor.css';

const PRESET_BASES: CustomBase[] = ['dark', 'light'];

const same = (a: CustomTheme, b: CustomTheme) =>
    CUSTOM_COLOR_FIELDS.every(({ key }) => a[key].toLowerCase() === b[key].toLowerCase()) && a.base === b.base;

const presetValue = (p: (typeof CUSTOM_PRESETS)[number]) => `${p.theme.base}:${p.name}`;

const filterPreset = (value: string, search: string, keywords?: string[]) => {
    const text = [value, ...(keywords ?? [])].join(' ').toLowerCase();
    return search.trim().toLowerCase().split(/\s+/).every(term => text.includes(term)) ? 1 : 0;
};

export function CustomThemeEditor() {
    const presetId = useId();
    const [presetOpen, setPresetOpen] = useState(false);
    const settings = useThemeSettings();
    const custom = settings.custom ?? CUSTOM_BASES.dark;
    const selectedPreset = CUSTOM_PRESETS.find(p => same(p.theme, custom));
    const apply = (next: CustomTheme) => setThemeSettings({ mode: 'custom', custom: next });
    return (
        <div className={styles.editor}>
            <FieldGroup>
                <Field className="gap-2">
                    <FieldLabel htmlFor={presetId}>
                        <span className={hud.settingLabel}>Codex 預設組合</span>
                    </FieldLabel>
                    <Popover open={presetOpen} onOpenChange={setPresetOpen}>
                        <PopoverTrigger asChild>
                            <Button
                                id={presetId}
                                role="combobox"
                                aria-expanded={presetOpen}
                                aria-haspopup="listbox"
                                variant="outline"
                                size="compact"
                                className="w-full max-w-[16rem] justify-between"
                                onKeyDown={(event) => {
                                    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                                        event.preventDefault();
                                        setPresetOpen(true);
                                    }
                                }}
                            >
                                {selectedPreset ? (
                                    <span className={styles.presetOption}>
                                        <span className={styles.presetChip} aria-hidden="true">
                                            <span style={{ background: selectedPreset.theme.background }} />
                                            <span style={{ background: selectedPreset.theme.panel }} />
                                            <span style={{ background: selectedPreset.theme.accent }} />
                                        </span>
                                        <span>{selectedPreset.name} · {selectedPreset.theme.base === 'dark' ? '深色' : '淺色'}</span>
                                    </span>
                                ) : '自訂配色'}
                                <ChevronsUpDown data-icon="inline-end" aria-hidden="true" />
                            </Button>
                        </PopoverTrigger>
                        <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] max-w-[calc(100vw-2rem)] p-0">
                            <Command size="compact" loop label="搜尋 Codex 主題" filter={filterPreset} defaultValue={selectedPreset ? presetValue(selectedPreset) : undefined}>
                                <CommandInput placeholder="搜尋主題名稱或深淺色…" aria-label="搜尋 Codex 主題" />
                                <CommandList className="max-h-[min(16rem,calc(var(--radix-popover-content-available-height,24rem)-2.5rem))]">
                                    <CommandEmpty>找不到符合的主題</CommandEmpty>
                                    {PRESET_BASES.map((key) => {
                                        const name = key === 'dark' ? '深色' : '淺色';
                                        return (
                                            <CommandGroup key={key} heading={`${name}主題`}>
                                                {CUSTOM_PRESETS.filter(p => p.theme.base === key).map((p) => (
                                                    <CommandItem
                                                        key={p.name}
                                                        value={presetValue(p)}
                                                        keywords={[p.name, name, key]}
                                                        onSelect={() => {
                                                            apply(p.theme);
                                                            setPresetOpen(false);
                                                        }}
                                                    >
                                                        <span className={styles.presetOption}>
                                                            <span className={styles.presetChip} aria-hidden="true">
                                                                <span style={{ background: p.theme.background }} />
                                                                <span style={{ background: p.theme.panel }} />
                                                                <span style={{ background: p.theme.accent }} />
                                                            </span>
                                                            <span>{p.name} · {name}</span>
                                                        </span>
                                                        {selectedPreset === p && <Check className="ml-auto" aria-hidden="true" />}
                                                    </CommandItem>
                                                ))}
                                            </CommandGroup>
                                        );
                                    })}
                                </CommandList>
                            </Command>
                        </PopoverContent>
                    </Popover>
                </Field>
            </FieldGroup>
            <span className={hud.settingLabel}>顏色（點色塊開啟選色器）</span>
            <div className={styles.swatches}>
                {CUSTOM_COLOR_FIELDS.map(({ key, label }) => (
                    <Label key={key} className={styles.swatch}>
                        <Input
                            type='color'
                            className={styles.colorInput}
                            value={custom[key]}
                            aria-label={`${label}顏色`}
                            onChange={(e) => apply({ ...custom, [key]: e.target.value })}
                        />
                        <span>{label}</span>
                        <span className={styles.hex}>{custom[key].toUpperCase()}</span>
                    </Label>
                ))}
            </div>
            <div className={styles.preview}>
                <span>預覽</span>
                <span className={panel.dirText.up}>▲ +1.25 上漲</span>
                <span className={panel.dirText.down}>▼ -1.25 下跌</span>
                <span className={styles.previewAccent}>連動</span>
            </div>
            <Button size="compact" variant="ghost"
                className={styles.reset}
                disabled={same(custom, CUSTOM_BASES[custom.base])}
                onClick={() => apply(CUSTOM_BASES[custom.base])}
            >
                重設為預設配色
            </Button>
        </div>
    );
}
