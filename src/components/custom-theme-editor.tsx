import { useId, useState, type CSSProperties } from 'react';
import { Check, ChevronDown, ChevronRight, Copy, Download, Settings2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { SelectControl, SelectOption } from '@/components/ui/select-control';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useEscClose } from '../hooks/use-esc-close';
import { CUSTOM_BASES, CUSTOM_COLOR_FIELDS, CUSTOM_PRESETS, type CustomTheme } from '../lib/custom-theme';
import { activeCustom, baseMode, currentTheme, setThemeSettings, useThemeSettings, type ThemeMode } from '../lib/theme-store';
import * as panel from './panel.css';
import * as styles from './custom-theme-editor.css';

const MODES: { key: ThemeMode; label: string }[] = [
    { key: 'system', label: '跟隨系統' },
    { key: 'light', label: '淺色' },
    { key: 'dark', label: '深色' },
];
const DEFAULT_PRESET = 'Absolutely';
const filterPreset = (value: string, search: string, keywords?: string[]) => {
    const text = [value, ...(keywords ?? [])].join(' ').toLowerCase();
    return search.trim().toLowerCase().split(/\s+/).every(term => text.includes(term)) ? 1 : 0;
};

function ThemePreview({ theme }: { theme: CustomTheme }) {
    return <span className={styles.previewWindow} style={{
        '--preview-background': theme.background,
        '--preview-panel': theme.panel,
        '--preview-foreground': theme.foreground,
        '--preview-accent': theme.accent,
    } as CSSProperties}>
        <span className={styles.previewSidebar}><Settings2 /></span>
        <span className={styles.previewContent}>
            <span className={styles.previewLine} /><span className={styles.previewLine} />
            <span className={styles.previewLine} /><span className={styles.previewLine} />
            <span className={styles.previewComposer}><span /></span>
        </span>
    </span>;
}

export function CustomThemeEditor() {
    const presetId = useId();
    const advancedId = useId();
    const [presetOpen, setPresetOpen] = useState(false);
    const [advancedOpen, setAdvancedOpen] = useState(false);
    useEscClose(() => setPresetOpen(false), presetOpen);
    const settings = useThemeSettings();
    const base = baseMode(settings);
    const custom = currentTheme(settings);
    const requestedName = settings.preset === 'custom' ? '自訂配色' : settings.preset ?? DEFAULT_PRESET;
    const unavailable = !!settings.preset && !activeCustom(settings);
    const selectedPreset = unavailable ? DEFAULT_PRESET : settings.preset ?? DEFAULT_PRESET;
    const selectedName = unavailable ? DEFAULT_PRESET : requestedName;
    const presets = CUSTOM_PRESETS.filter(p => p.theme.base === base);
    const apply = (next: CustomTheme) => setThemeSettings({ preset: 'custom', custom: next, accent: undefined });
    const selectPreset = (preset?: string) => {
        setThemeSettings({ preset });
        setPresetOpen(false);
    };
    const themeJson = () => JSON.stringify(custom, null, 2);
    const copyTheme = async () => {
        try { await navigator.clipboard.writeText(themeJson()); toast.success('已複製主題配色'); }
        catch { toast.error('無法複製主題，請使用匯出主題下載配色。'); }
    };
    const exportTheme = () => {
        const url = URL.createObjectURL(new Blob([themeJson()], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = `fubon-theme-${selectedPreset}-${base}.json`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    };

    return <section className={styles.appearance} aria-label="視覺風格">
        <h3 className={styles.heading}>視覺風格</h3>
        <div className={styles.modeRow}>
            <span className={styles.rowLabel} id={`${presetId}-mode`}>模式</span>
            <ToggleGroup type="single" value={settings.mode} aria-labelledby={`${presetId}-mode`} className={styles.modeOptions}>
                {MODES.map(({ key, label }) => <ToggleGroupItem key={key} value={key}
                    className={styles.modeOption} aria-label={label} title={label}
                    onClick={() => setThemeSettings({ mode: key })}>
                    <span className={styles.modePreview} data-mode={key} aria-hidden="true">
                        {key === 'system' ? <>
                            <ThemePreview theme={currentTheme({ ...settings, mode: 'light' })} />
                            <ThemePreview theme={currentTheme({ ...settings, mode: 'dark' })} />
                        </> : <ThemePreview theme={currentTheme({ ...settings, mode: key })} />}
                    </span>
                    <span className="sr-only">{label}</span>
                </ToggleGroupItem>)}
            </ToggleGroup>
        </div>
        <div className={styles.themeCard}>
            <div className={styles.settingRow}>
                <label htmlFor={presetId} className={styles.rowLabel}>主題</label>
                <div className={styles.themeControls}>
                    <Button variant="ghost" size="compact-icon" className={styles.iconButton} aria-label="匯出主題" title="匯出主題" onClick={exportTheme}><Download /></Button>
                    <Button variant="ghost" size="compact-icon" className={styles.iconButton} aria-label="複製主題" title="複製主題" onClick={() => { void copyTheme(); }}><Copy /></Button>
                    <Popover open={presetOpen} onOpenChange={setPresetOpen}>
                        <PopoverTrigger asChild>
                            <Button id={presetId} role="combobox" aria-expanded={presetOpen} aria-haspopup="listbox"
                                variant="outline" size="compact" className={styles.presetTrigger}
                                onKeyDown={event => {
                                    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                                        event.preventDefault(); setPresetOpen(true);
                                    }
                                }}>
                                <span className={styles.presetOption}><span className={styles.typeChip} aria-hidden="true">Aa</span><span className={styles.presetName}>{selectedName}</span></span>
                                <ChevronDown aria-hidden="true" />
                            </Button>
                        </PopoverTrigger>
                        <PopoverContent align="end" className="w-64 max-w-[calc(100vw-2rem)] p-0" onEscapeKeyDown={event => event.preventDefault()}>
                            <Command size="compact" loop label="搜尋主題" filter={filterPreset} defaultValue={selectedPreset}>
                                <CommandInput placeholder="搜尋主題…" aria-label="搜尋主題" />
                                <CommandList className="max-h-[min(16rem,calc(var(--radix-popover-content-available-height,24rem)-2.5rem))]">
                                    <CommandEmpty>找不到符合的主題</CommandEmpty>
                                    <CommandGroup>
                                        {settings.custom?.base === base && <CommandItem value="custom" keywords={['自訂配色']} onSelect={() => selectPreset('custom')}>
                                            自訂配色{selectedPreset === 'custom' && <Check className="ml-auto" aria-hidden="true" />}
                                        </CommandItem>}
                                        {presets.map(({ name, theme: presetTheme }) => {
                                            const theme = name === DEFAULT_PRESET && settings.preset !== DEFAULT_PRESET ? CUSTOM_BASES[base] : presetTheme;
                                            return <CommandItem key={name} value={name}
                                                keywords={[theme.base, base === 'dark' ? '深色' : '淺色', ...(name === DEFAULT_PRESET ? ['預設'] : [])]}
                                                onSelect={() => selectPreset(name === DEFAULT_PRESET ? undefined : name)}>
                                                <span className={styles.presetOption}>
                                                    <span className={styles.presetChip} aria-hidden="true"><span style={{ background: theme.background }} /><span style={{ background: theme.panel }} /><span style={{ background: theme.accent }} /></span>
                                                    <span>{name}</span>
                                                </span>
                                                {selectedPreset === name && <Check className="ml-auto" aria-hidden="true" />}
                                            </CommandItem>;
                                        })}
                                    </CommandGroup>
                                </CommandList>
                            </Command>
                        </PopoverContent>
                    </Popover>
                </div>
            </div>
            <div className={styles.settingRow}>
                <span className={styles.rowLabel}>強調色</span>
                <div className={styles.accentControls}>
                    <SelectControl aria-label="強調色來源" value={settings.accent ? 'custom' : 'theme'} className={styles.accentSelect}
                        onValueChange={selectedValue => setThemeSettings({ accent: selectedValue === 'custom' ? custom.accent : undefined })}>
                        <SelectOption value="theme">主題預設</SelectOption>
                        <SelectOption value="custom">自訂</SelectOption>
                    </SelectControl>
                    <Label className={styles.accentPicker}>
                        <Input type="color" className={styles.colorInput} value={custom.accent} aria-label="強調色顏色"
                            onChange={event => setThemeSettings({ accent: event.target.value })} />
                        <span className={styles.hex}>{custom.accent.toUpperCase()}</span>
                    </Label>
                </div>
            </div>
            {unavailable && <p className={styles.fallbackHint} role="status">{requestedName}沒有{base === 'dark' ? '深色' : '淺色'}版本，目前使用此模式的預設配色。</p>}
            <Button variant="ghost" size="compact" className={styles.advancedToggle} aria-expanded={advancedOpen} aria-controls={advancedId}
                onClick={() => setAdvancedOpen(!advancedOpen)}>
                {advancedOpen ? <ChevronDown /> : <ChevronRight />}進階配色
            </Button>
            {advancedOpen && <div className={styles.editor} id={advancedId}>
                <div className={styles.swatches}>
                    {CUSTOM_COLOR_FIELDS.filter(field => field.key !== 'accent').map(({ key, label }) => <Label key={key} className={styles.swatch}>
                        <Input type="color" className={styles.colorInput} value={custom[key]} aria-label={`${label}顏色`}
                            onChange={event => apply({ ...custom, [key]: event.target.value })} />
                        <span>{label}</span><span className={styles.hex}>{custom[key].toUpperCase()}</span>
                    </Label>)}
                </div>
                <div className={styles.preview}>
                    <span>預覽</span><span className={panel.dirText.up}>▲ +1.25 上漲</span><span className={panel.dirText.down}>▼ -1.25 下跌</span><span className={styles.previewAccent}>連動</span>
                </div>
                <Button size="compact" variant="ghost" className={styles.reset}
                    onClick={() => setThemeSettings({ preset: undefined, accent: undefined, custom: CUSTOM_BASES[base] })}>
                    重設為預設配色
                </Button>
            </div>}
        </div>
    </section>;
}
