import { Tabs, TabsList, TabsTrigger, TabsContent } from './ui/tabs';
import { TerminalDialog } from './terminal-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { SelectControl, SelectOption } from '@/components/ui/select-control';
// src/components/indicator-dialog.tsx — TradingView-style indicator picker
// (search / category sidebar / favorites / add-in-place) and the
// per-instance settings modal（計算參數 / 外觀 / 顯示週期）.

import {
    Check,
    ChevronDown,
    LineChart,
    Pencil,
    Plus,
    Search,
    SquareFunction,
    Star,
    Waves,
    X,
} from 'lucide-react';
import { Fragment, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
    CUSTOM_PREFIX,
    customType,
    getCustom,
    listCustoms,
    subscribeCustoms,
    type CustomIndicator,
} from '../lib/custom-indicators';
import {
    DEF_BY_TYPE,
    factoryInstance,
    INDICATOR_DEFS,
    loadFavorites,
    outputLineStyle,
    outputStyle,
    saveFavorites,
    saveTypeDefault,
    type IndicatorDef,
    type IndicatorInstance,
    type OutputStyle,
    type PlotKind,
} from '../lib/indicator-defs';
import { CustomIndicatorEditor } from './custom-indicator-editor';
import { bandColors } from '../lib/price-band';
import type { MALinePreset } from '../lib/ma-presets';
import { listMAGroups, subscribeMAGroups, type MAGroup } from '../lib/ma-groups';
import type { MAHistoryStatus } from '../lib/ma-history';
import { MAGroupEditor } from './ma-group-editor';
import { MAHistoryNotice } from './ma-history-notice';
import { IndicatorColorPalette } from './indicator-color-picker';
import { IndicatorManager, type IndicatorManagement } from './indicator-manager';
export { COLOR_GRID } from './indicator-color-picker';
import * as styles from './indicator-dialog.css';

const WIDTHS: (1 | 2 | 3 | 4)[] = [1, 2, 3, 4];

export const PLOT_LABEL: Record<PlotKind, string> = {
    line: '線',
    step: '階梯線',
    area: '面積',
    histogram: '柱狀',
    circles: '圓點',
};

const PLOT_KINDS: PlotKind[] = ['line', 'step', 'area', 'histogram', 'circles'];

const PRECISIONS: (number | undefined)[] = [undefined, 0, 1, 2, 3, 4];

type Category = 'all' | 'fav' | 'overlay' | 'pane' | 'custom';

const CATEGORIES: { key: Category; label: string }[] = [
    { key: 'all', label: '全部指標' },
    { key: 'fav', label: '我的最愛' },
    { key: 'overlay', label: '主圖疊加' },
    { key: 'pane', label: '副圖指標' },
    { key: 'custom', label: '自訂指標' },
];

export function IndicatorDialog({
    instances,
    onAdd,
    onAddMAGroup,
    maHistoryStatus,
    onRetryMAHistory,
    onClose,
    onSaveDefaults,
    management,
}: {
    instances: IndicatorInstance[];
    onAdd: (type: string) => void;
    onAddMAGroup: (lines: readonly MALinePreset[]) => void;
    maHistoryStatus?: MAHistoryStatus | null;
    onRetryMAHistory?: () => void;
    onClose: () => void;
    onSaveDefaults?: () => void;
    management?: IndicatorManagement;
}) {
    const [view, setView] = useState(management && instances.length ? 'current' : 'add');
    const [query, setQuery] = useState('');
    const [category, setCategory] = useState<Category>('all');
    const [favs, setFavs] = useState<Set<string>>(loadFavorites);
    // null = 關閉；{ existing: null } = 建立新自訂指標
    const [editorFor, setEditorFor] = useState<{
        existing: CustomIndicator | null;
    } | null>(null);
    const [, setCustomVer] = useState(0); // 自訂指標增刪改 → 重新渲染列表
    const inputRef = useRef<HTMLInputElement>(null);
    const groups = useSyncExternalStore(subscribeMAGroups, listMAGroups);
    const [groupEditor, setGroupEditor] = useState<{ group?: MAGroup; initialLines: MALinePreset[] } | null>(null);
    const editGroup = (group?: MAGroup) => {
        const seen = new Set<number>();
        const current = instances.filter(instance => {
            if (instance.type !== 'sma' || seen.has(instance.params.period!)) return false;
            seen.add(instance.params.period!);
            return true;
        }).slice(0, 12).map(instance => ({ period: instance.params.period!, color: outputStyle(instance, DEF_BY_TYPE.get('sma')!, 'line').color }));
        const ma = DEF_BY_TYPE.get('sma')!;
        setGroupEditor({ group, initialLines: current.length ? current : [{ period: ma.params[0]!.def, color: ma.outputs[0]!.color }] });
    };

    useEffect(() => subscribeCustoms(() => setCustomVer((v) => v + 1)), []);

    useEffect(() => {
        if (view === 'add') inputRef.current?.focus();
    }, [view]);

    const toggleFav = (type: string) => {
        setFavs((prev) => {
            const next = new Set(prev);
            if (next.has(type)) next.delete(type);
            else next.add(type);
            saveFavorites(next);
            return next;
        });
    };

    const counts = useMemo(() => {
        const m = new Map<string, number>();
        for (const i of instances) m.set(i.type, (m.get(i.type) ?? 0) + 1);
        return m;
    }, [instances]);

    const q = query.trim().toLowerCase();
    const maQuery = q.replace(/[\s()（）]/g, '');
    const periodQuery = /^(?:s?ma)?(\d{1,3})(?:期|根)?$/.exec(maQuery);
    const matchesMAPeriod = !!periodQuery && Number(periodQuery[1]) >= 1 && Number(periodQuery[1]) <= 500;
    const maPeriods = new Set(instances.filter(i => i.type === 'sma').map(i => i.params.period));
    const showAllMAGroups = !q || matchesMAPeriod || [DEF_BY_TYPE.get('sma')!.label, ...DEF_BY_TYPE.get('sma')!.aliases].some(alias => alias.toLowerCase().includes(q));
    const matches = (d: IndicatorDef) =>
        !q ||
        d.label.toLowerCase().includes(q) ||
        d.short.toLowerCase().includes(q) ||
        d.desc.toLowerCase().includes(q) ||
        d.aliases.some((a) => a.toLowerCase().includes(q)) ||
        (d.type === 'sma' && (matchesMAPeriod || groups.some(group => group.name.toLowerCase().includes(q))));

    const isCustom = (d: IndicatorDef) => d.type.startsWith(CUSTOM_PREFIX);

    const inCategory = (d: IndicatorDef) =>
        category === 'all' ||
        (category === 'fav' && favs.has(d.type)) ||
        (category === 'custom' && isCustom(d)) ||
        d.category === category;

    // 內建 + 自訂（自訂的動態 def 已註冊進 DEF_BY_TYPE）
    const allDefs = [
        ...INDICATOR_DEFS,
        ...listCustoms()
            .map((c) => DEF_BY_TYPE.get(customType(c.id)))
            .filter((d): d is IndicatorDef => !!d),
    ];
    const filtered = allDefs.filter((d) => matches(d) && inCategory(d));
    const overlays = filtered.filter((d) => d.category === 'overlay');
    const panes = filtered.filter((d) => d.category === 'pane');

    const renderRow = (d: IndicatorDef) => {
        const added = counts.get(d.type) ?? 0;
        const summary = <>
                <span
                    className={styles.rowSwatch}
                    style={{ background: d.outputs[0]!.color }}
                />
                <span className={styles.rowMain}>
                    <span className={styles.rowName}>
                        {d.label}
                        {isCustom(d) && (
                            <span className={styles.customTag}>自訂</span>
                        )}
                    </span>
                    <span className={styles.rowDesc}>{d.type === 'sma' ? '自訂 K 棒根數、顏色與顯示週期' : d.desc}</span>
                </span>
                {added > 0 && (
                    <span className={styles.rowAdded}>已加入 {added} {d.type === 'sma' ? '條' : '個'}</span>
                )}
        </>;
        return (
            <Fragment key={d.type}>
            <div className={d.type === 'sma' ? `${styles.row} ${styles.maCatalogRow}` : styles.row}>
                {d.type === 'sma' ? <>
                    <div className={styles.catalogSummary}>{summary}</div>
                    <Button size="compact" variant="outline" className={styles.maCustomAdd} onClick={() => onAdd('sma')}
                        title="自訂計算根數與外觀後加入圖表"><Plus size={13} />自訂均線</Button>
                </> : <Button size="compact" variant="ghost" className={styles.catalogAdd} onClick={() => onAdd(d.type)}>{summary}</Button>}
                {isCustom(d) && (
                    <Button size="compact-icon" variant="ghost"
                        className={styles.starBtn.normal}
                        title='編輯自訂指標'
                        aria-label={`編輯 ${d.label}`}
                        onClick={() => {
                            const c = getCustom(
                                d.type.slice(CUSTOM_PREFIX.length),
                            );
                            if (c) setEditorFor({ existing: c });
                        }}
                    >
                        <Pencil size={13} />
                    </Button>
                )}
                <Button size="compact-icon" variant="ghost"
                    className={
                        styles.starBtn[favs.has(d.type) ? 'active' : 'normal']
                    }
                    aria-label={`${favs.has(d.type) ? '取消收藏' : '收藏'} ${d.label}`}
                    aria-pressed={favs.has(d.type)}
                    title={favs.has(d.type) ? '取消收藏' : '加入我的最愛'}
                    onClick={() => toggleFav(d.type)}
                >
                    <Star
                        size={13}
                        fill={favs.has(d.type) ? 'currentColor' : 'none'}
                    />
                </Button>
            </div>
            {d.type === 'sma' && (
                <div className={styles.maPresets} role="group" aria-label="我的均線組合">
                    {groups.length > 0 && <div className={styles.sectionTitle}>我的均線組合</div>}
                    {groups.filter(group => showAllMAGroups || group.name.toLowerCase().includes(q)).map(group => {
                        const missing = group.lines.filter(line => !maPeriods.has(line.period)).length;
                        const exists = missing === 0;
                        return <div key={group.id} className={styles.maGroupRow}>
                            <Button size="compact" variant="outline" className={styles.maGroupApply} disabled={exists}
                                aria-label={exists ? `${group.name}（已加入）` : `套用 ${group.name}`} onClick={() => onAddMAGroup(group.lines)}>
                                {exists ? <Check size={13} /> : <Plus size={13} />}
                                <span className={styles.rowMain}>
                                    <span>{group.name}</span>
                                    <span className={styles.maPresetHint}>{group.lines.map(line => line.period).join('／')}</span>
                                </span>
                                <span className={styles.maGroupAction}>{exists ? '已全部加入' : `套用 · 加入 ${missing} 條`}</span>
                            </Button>
                            <Button size="compact" variant="ghost" aria-label={`編輯 ${group.name}`}
                                title="編輯儲存的組合；圖上已加入的均線維持原設定"
                                onClick={() => editGroup(group)}><Pencil size={13} />編輯組合</Button>
                        </div>;
                    })}
                    <Button size="compact" variant="outline" onClick={() => editGroup()}><Plus size={13} />建立均線組合</Button>
                    {groups.length > 0 && <div className={styles.maPresetHint}>套用組合只加入缺少的均線，不會覆蓋已加入均線的設定。</div>}
                    {maHistoryStatus && onRetryMAHistory && <MAHistoryNotice status={maHistoryStatus} onRetry={onRetryMAHistory} />}
                </div>
            )}
            </Fragment>
        );
    };

    // portal 到 body：面板（react-grid-item）有 transform，會把 fixed
    // overlay 困在面板的 containing block / stacking context 裡 —
    // 視窗溢出面板又被其他面板蓋住（issue #39）
    return (
        <TerminalDialog title="技術指標" onClose={onClose} layout="custom" className={styles.dialog}>
                <div className={styles.header}>
                    技術指標
                    <Button size="compact" variant="ghost" aria-label="關閉技術指標" className={styles.closeBtn} onClick={onClose}>
                        <X size={16} />
                    </Button>
                </div>
                <Tabs value={view} onValueChange={setView} className={styles.pickerTabs}>
                    <TabsList className={styles.pickerTabList} aria-label="指標操作">
                        {management && <TabsTrigger value="current">已加入（{instances.length}）</TabsTrigger>}
                        <TabsTrigger value="add">新增指標</TabsTrigger>
                    </TabsList>
                    {management && <TabsContent value="current" className={styles.pickerContent}>
                        <IndicatorManager instances={instances} management={management} onAdd={() => setView('add')} />
                    </TabsContent>}
                    <TabsContent value="add" className={styles.pickerContent}>
                <div className={styles.searchWrap}>
                    <Search size={14} />
                    <Input
                        ref={inputRef}
                        aria-label="搜尋指標"
                        className={styles.searchInput}
                        placeholder='搜尋指標（名稱、縮寫、中英文都可以）'
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                    />
                    {query && (
                        <Button size="compact" variant="ghost"
                            className={styles.closeBtn}
                            aria-label="清除搜尋"
                            onClick={() => setQuery('')}
                        >
                            <X size={13} />
                        </Button>
                    )}
                </div>
                <div className={styles.body}>
                    <div className={styles.sidebar}>
                        <div className={styles.sideTitle}>分類</div>
                        {CATEGORIES.map((c) => (
                            <Button size="compact" variant="ghost"
                                key={c.key}
                                className={
                                    styles.sideItem[
                                        category === c.key
                                            ? 'active'
                                            : 'normal'
                                    ]
                                }
                                onClick={() => setCategory(c.key)}
                            >
                                {c.key === 'fav' ? (
                                    <Star size={13} />
                                ) : c.key === 'overlay' ? (
                                    <LineChart size={13} />
                                ) : c.key === 'pane' ? (
                                    <Waves size={13} />
                                ) : c.key === 'custom' ? (
                                    <SquareFunction size={13} />
                                ) : (
                                    <Search size={13} />
                                )}
                                {c.label}
                            </Button>
                        ))}
                        <Button size="compact" variant="outline"
                            className={styles.newCustomBtn}
                            onClick={() => setEditorFor({ existing: null })}
                        >
                            <Plus size={13} />
                            建立自訂指標
                        </Button>
                    </div>
                    <div className={styles.list}>
                        {filtered.length === 0 &&
                            (category === 'custom' && !q ? (
                                <div className={styles.empty}>
                                    還沒有自訂指標 —
                                    用左下「建立自訂指標」寫你自己的第一個
                                </div>
                            ) : (
                                <div className={styles.empty}>
                                    沒有符合「{query}」的指標
                                </div>
                            ))}
                        {overlays.length > 0 && (
                            <>
                                <div className={styles.listHeader}>
                                    主圖疊加
                                </div>
                                {overlays.map(renderRow)}
                            </>
                        )}
                        {panes.length > 0 && (
                            <>
                                <div className={styles.listHeader}>
                                    副圖指標
                                </div>
                                {panes.map(renderRow)}
                            </>
                        )}
                    </div>
                </div>
                    </TabsContent>
                </Tabs>
                <div className={styles.footer}>
                    {view === 'add' && <span className={styles.footerHint}>設定後按「加入圖表」；修改現有指標請到「已加入」。</span>}
                    <span>已加入 {instances.length} 個{instances.some(instance => instance.hidden) ? `，隱藏 ${instances.filter(instance => instance.hidden).length} 個` : ''}</span>
                    {onSaveDefaults && <Button size="compact" variant="ghost" type='button' onClick={onSaveDefaults}>存為新圖／回測預設</Button>}
                </div>

            {editorFor && (
                <CustomIndicatorEditor
                    existing={editorFor.existing}
                    onClose={() => setEditorFor(null)}
                />
            )}
            {groupEditor && <MAGroupEditor {...groupEditor} onClose={() => setGroupEditor(null)} />}
        </TerminalDialog>
    );
}

// ---- per-instance settings（計算參數 / 外觀 / 顯示週期）----

// TradingView-style color panel: grid + hex + opacity + thickness,
// expanded inline under the output row（modal 內不會被裁切）
function ColorPanel({
    style: s,
    showWidth,
    onChange,
}: {
    style: ReturnType<typeof outputStyle>;
    showWidth: boolean;
    onChange: (patch: OutputStyle) => void;
}) {
    return (
        <div className={styles.colorPanel}>
            <IndicatorColorPalette color={s.color} onChange={color => onChange({ color })} />
            <div className={styles.colorTools}>
                <span className={styles.colorToolLabel}>透明度</span>
                <Slider
                    className={styles.opacitySlider}
                    min={10}
                    max={100}
                    step={5}
                    value={[Number(s.opacity)]}
                    onValueChange={(e) =>
                        onChange({ opacity: Number(e[0]!) })
                    }
                />
                <span className={styles.opacityValue}>{s.opacity}%</span>
            </div>
            {showWidth && (
                <div className={styles.colorTools}>
                    <span className={styles.colorToolLabel}>粗細</span>
                    {WIDTHS.map((w) => (
                        <Button size="compact-icon" variant="outline"
                            key={w}
                            className={
                                styles.widthBtn[
                                    s.width === w ? 'active' : 'normal'
                                ]
                            }
                            title={`${w}px`}
                            onClick={() => onChange({ width: w })}
                        >
                            <span
                                className={styles.widthLine}
                                style={{ height: `${w}px` }}
                            />
                        </Button>
                    ))}
                </div>
            )}
        </div>
    );
}

export function IndicatorSettingsModal({
    inst,
    timeframes,
    isNew = false,
    currentTimeframe,
    onPatch,
    onRemove,
    onCommit,
    onCancel,
}: {
    inst: IndicatorInstance;
    timeframes: { label: string; minutes: number }[];
    isNew?: boolean;
    currentTimeframe?: number;
    onPatch: (patch: Partial<IndicatorInstance>) => void;
    onRemove: () => void;
    onCommit: () => void;
    onCancel: () => void;
}) {
    const def = DEF_BY_TYPE.get(inst.type);
    const [tab, setTab] = useState<'inputs' | 'style' | 'visibility'>(
        def && def.params.length > 0 ? 'inputs' : 'style',
    );
    // which output has its color panel / plot menu expanded
    const [colorFor, setColorFor] = useState<string | null>(null);
    const [plotFor, setPlotFor] = useState<string | null>(null);
    const [defaultsOpen, setDefaultsOpen] = useState(false);
    const [savedTip, setSavedTip] = useState(false);
    const calculationHelpId = useId();

    if (!def) return null;

    const patchStyle = (key: string, patch: OutputStyle) => {
        onPatch({
            styles: {
                ...inst.styles,
                [key]: { ...inst.styles?.[key], ...patch },
            },
        });
    };

    const tfList = inst.visibleTf; // undefined = all
    const timeframeLabel = (minutes: number) => {
        if (minutes === 1440) return '日 K';
        if (minutes === 10080) return '週 K';
        if (minutes === 43200) return '月 K';
        return `${minutes} 分 K`;
    };
    const maPeriod = inst.params.period ?? def.params.find(p => p.key === 'period')?.def;
    const tfChecked = (m: number) => !tfList || tfList.includes(m);
    const toggleTf = (m: number) => {
        const all = timeframes.map((t) => t.minutes);
        const cur = tfList ?? all;
        const next = tfChecked(m)
            ? cur.filter((x) => x !== m)
            : [...cur, m];
        onPatch({
            visibleTf: next.length >= all.length ? undefined : next,
        });
    };

    // 同 IndicatorDialog：portal 到 body 逃出面板的 transform 陷阱
    return (
        <TerminalDialog title="指標設定" onClose={onCancel} layout="custom" className={styles.settingsDialog}>
                <div className={styles.header}>
                    {isNew ? '新增' : '編輯'} {def.label}
                    <Button size="compact" variant="ghost" className={styles.closeBtn} aria-label="取消指標設定" onClick={onCancel}>
                        <X size={16} />
                    </Button>
                </div>
                <Tabs value={tab} onValueChange={next => setTab(next as 'inputs' | 'style' | 'visibility')} className="flex min-h-0 flex-1 flex-col"><TabsList className={styles.tabs}>
                    {def.params.length > 0 && (
                        <TabsTrigger value="inputs">
                            計算參數
                        </TabsTrigger>
                    )}
                    <TabsTrigger value="style">
                        外觀
                    </TabsTrigger>
                    <TabsTrigger value="visibility">
                        顯示週期
                    </TabsTrigger>
                </TabsList>
                <TabsContent value={tab} className={styles.settingsBody}>
                    {tab === 'inputs' &&
                        def.params.map((p) => (
                            <Label key={p.key} className={styles.fieldRow}>
                                <span>{inst.type === 'sma' && p.key === 'period' ? '計算期間（K 棒根數）' : p.label}</span>
                                <Input
                                    type='number'
                                    aria-describedby={inst.type === 'sma' && p.key === 'period' ? calculationHelpId : undefined}
                                    className={styles.fieldInput}
                                    min={p.min}
                                    max={p.max}
                                    step={p.step ?? 1}
                                    value={inst.params[p.key] ?? p.def}
                                    onChange={(e) => {
                                        const v = Number(e.target.value);
                                        if (!Number.isFinite(v)) return;
                                        onPatch({
                                            params: {
                                                ...inst.params,
                                                [p.key]: Math.min(
                                                    p.max,
                                                    Math.max(p.min, v),
                                                ),
                                            },
                                        });
                                    }}
                                />
                            </Label>
                        ))}
                    {tab === 'inputs' && inst.type === 'sma' && (
                        <div id={calculationHelpId} className={styles.settingsHelp}>
                            <p>MA{maPeriod}：以最近 {maPeriod} 根 K 棒的收盤價計算平均。</p>
                            {currentTimeframe !== undefined && <p>目前圖表是 {timeframeLabel(currentTimeframe)}，使用 {maPeriod} 根 {timeframeLabel(currentTimeframe)} 計算。切換圖表週期時，根數維持 {maPeriod} 根。</p>}
                        </div>
                    )}
                    {tab === 'style' && (
                        <>
                            {def.outputs.map((o) => {
                                const s = outputStyle(inst, def, o.key);
                                // band 由 PriceBandPrimitive 繪製，線型選單
                                // （折線／柱狀／圓點…）對它沒有作用，不顯示；
                                // 粗細仍套在上下緣線
                                const isBand = o.kind === 'band';
                                const isLine =
                                    isBand ||
                                    (s.plot !== 'histogram' &&
                                        s.plot !== 'circles');
                                const lineStyle = outputLineStyle(o);
                                const band = isBand
                                    ? bandColors(s.color, s.opacity)
                                    : null;
                                return (
                                    <div
                                        key={o.key}
                                        className={styles.styleSection}
                                    >
                                        <div className={styles.styleRow}>
                                            <Label
                                                className={styles.styleHead}
                                            >
                                                <Checkbox
                                                    className={styles.checkbox}
                                                    checked={s.visible}
                                                    onCheckedChange={(e) =>
                                                        patchStyle(o.key, {
                                                            visible:
                                                                (e === true),
                                                        })
                                                    }
                                                />
                                                {o.label}
                                            </Label>
                                            <div
                                                className={
                                                    styles.styleRowBtns
                                                }
                                            >
                                                <Button size="compact" variant="ghost"
                                                    className={
                                                        styles.previewBtn[
                                                            colorFor === o.key
                                                                ? 'active'
                                                                : 'normal'
                                                        ]
                                                    }
                                                    title='顏色 / 透明度 / 粗細'
                                                    onClick={() => {
                                                        setPlotFor(null);
                                                        setColorFor(
                                                            colorFor === o.key
                                                                ? null
                                                                : o.key,
                                                        );
                                                    }}
                                                >
                                                    <span
                                                        className={
                                                            styles.previewSwatch
                                                        }
                                                        style={{
                                                            background:
                                                                s.color,
                                                            opacity:
                                                                s.opacity /
                                                                100,
                                                        }}
                                                    />
                                                    {band ? (
                                                        <span
                                                            className={
                                                                styles.previewBand
                                                            }
                                                            style={{
                                                                background:
                                                                    band.fillColor,
                                                                borderTop: `${s.width}px ${lineStyle} ${band.borderColor}`,
                                                                borderBottom: `${s.width}px ${lineStyle} ${band.borderColor}`,
                                                            }}
                                                        />
                                                    ) : (
                                                        <span
                                                            className={
                                                                styles.previewLine
                                                            }
                                                            style={
                                                                lineStyle ===
                                                                'dashed'
                                                                    ? {
                                                                          borderTop: `${s.width}px dashed ${s.color}`,
                                                                      }
                                                                    : {
                                                                          background:
                                                                              s.color,
                                                                          height: `${s.width}px`,
                                                                      }
                                                            }
                                                        />
                                                    )}
                                                </Button>
                                                {!isBand && (
                                                    <Button size="compact" variant="outline"
                                                        className={
                                                            styles.plotBtn[
                                                                plotFor === o.key
                                                                    ? 'active'
                                                                    : 'normal'
                                                            ]
                                                        }
                                                        title='線型'
                                                        onClick={() => {
                                                            setColorFor(null);
                                                            setPlotFor(
                                                                plotFor === o.key
                                                                    ? null
                                                                    : o.key,
                                                            );
                                                        }}
                                                    >
                                                        {PLOT_LABEL[s.plot]}
                                                        <ChevronDown size={11} />
                                                    </Button>
                                                )}
                                            </div>
                                        </div>
                                        {colorFor === o.key && (
                                            <ColorPanel
                                                style={s}
                                                showWidth={isLine}
                                                onChange={(patch) =>
                                                    patchStyle(o.key, patch)
                                                }
                                            />
                                        )}
                                        {plotFor === o.key && !isBand && (
                                            <div
                                                className={styles.plotMenu}
                                            >
                                                {PLOT_KINDS.map((k) => (
                                                    <Button size="compact" variant="ghost"
                                                        key={k}
                                                        className={
                                                            styles.plotItem[
                                                                s.plot === k
                                                                    ? 'active'
                                                                    : 'normal'
                                                            ]
                                                        }
                                                        onClick={() => {
                                                            patchStyle(o.key, {
                                                                plot: k,
                                                            });
                                                            setPlotFor(null);
                                                        }}
                                                    >
                                                        {PLOT_LABEL[k]}
                                                    </Button>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                            <div className={styles.sectionTitle}>
                                輸出數值
                            </div>
                            <Label className={styles.fieldRow}>
                                <span>小數位數</span>
                                <SelectControl
                                    className={styles.fieldSelect}
                                    value={inst.precision ?? 'auto'}
                                    onValueChange={(selectedValue) =>
                                        onPatch({
                                            precision:
                                                selectedValue === 'auto'
                                                    ? undefined
                                                    : Number(selectedValue),
                                        })
                                    }
                                >
                                    {PRECISIONS.map((p) => (
                                        <SelectOption
                                            key={p ?? 'auto'}
                                            value={p ?? 'auto'}
                                        >
                                            {p === undefined ? '自動' : p}
                                        </SelectOption>
                                    ))}
                                </SelectControl>
                            </Label>
                            <Label className={styles.fieldRow}>
                                <span>價格軸最新值標籤</span>
                                <Checkbox
                                    className={styles.checkbox}
                                    checked={inst.showLabels ?? false}
                                    onCheckedChange={(e) =>
                                        onPatch({
                                            showLabels: (e === true),
                                        })
                                    }
                                />
                            </Label>
                            <Label className={styles.fieldRow}>
                                <span>圖上顯示數值</span>
                                <Checkbox
                                    className={styles.checkbox}
                                    checked={inst.showValues ?? true}
                                    onCheckedChange={(e) =>
                                        onPatch({
                                            showValues: (e === true),
                                        })
                                    }
                                />
                            </Label>
                        </>
                    )}
                    {tab === 'visibility' && (
                        <>
                            <div className={styles.sectionTitle}>
                                勾選要顯示指標的圖表週期
                            </div>
                            <p className={styles.settingsHelp}>這裡只控制顯示；計算參數不會改變。未勾選的圖表週期會隱藏此指標。</p>
                            <div className={styles.maPresetOptions}>
                                <Button size="compact" variant="outline" disabled={!tfList} onClick={() => onPatch({ visibleTf: undefined })}>全部勾選</Button>
                                {currentTimeframe !== undefined && timeframes.some(t => t.minutes === currentTimeframe) && <Button size="compact" variant="outline"
                                    disabled={tfList?.length === 1 && tfList[0] === currentTimeframe}
                                    onClick={() => onPatch({ visibleTf: [currentTimeframe] })}>只勾選目前週期</Button>}
                            </div>
                            {timeframes.map((t) => (
                                <Label
                                    key={t.minutes}
                                    className={styles.fieldRow}
                                >
                                    <span>{timeframeLabel(t.minutes)}{t.minutes === currentTimeframe && <span className={styles.currentTimeframe}>（目前圖表）</span>}</span>
                                    <Checkbox
                                        className={styles.checkbox}
                                        checked={tfChecked(t.minutes)}
                                        onCheckedChange={() => toggleTf(t.minutes)}
                                    />
                                </Label>
                            ))}
                            {tfList?.length === 0 && <p className={styles.settingsHelp} role="status">目前全部未勾選，儲存後這條指標會在所有圖表週期隱藏。</p>}
                        </>
                    )}
                </TabsContent></Tabs>
                <p className={styles.previewHint}>{isNew ? '目前僅預覽；按「加入圖表」才會保留。' : '圖表即時預覽；取消會放棄這次圖表修改。'}</p>
                <div className={styles.settingsFooter}>
                    <div className={styles.defaultsWrap}>
                        <Button size="compact" variant="outline"
                            className={styles.cancelBtn}
                            onClick={() => setDefaultsOpen((o) => !o)}
                        >
                            預設設定 <ChevronDown size={11} />
                        </Button>
                        {defaultsOpen && (
                            <div className={styles.defaultsMenu}>
                                <Button size="compact" variant="ghost"
                                    className={styles.defaultsItem}
                                    onClick={() => {
                                        const f = factoryInstance(inst);
                                        onPatch({
                                            params: f.params,
                                            colors: f.colors,
                                            styles: undefined,
                                            precision: undefined,
                                            showLabels: undefined,
                                            showValues: undefined,
                                        });
                                        setDefaultsOpen(false);
                                    }}
                                >
                                    重設為內建預設
                                </Button>
                                <Button size="compact" variant="ghost"
                                    className={styles.defaultsItem}
                                    onClick={() => {
                                        saveTypeDefault(inst);
                                        setDefaultsOpen(false);
                                        setSavedTip(true);
                                        setTimeout(
                                            () => setSavedTip(false),
                                            1800,
                                        );
                                    }}
                                >
                                    存為我的預設
                                </Button>
                            </div>
                        )}
                        {savedTip && (
                            <span className={styles.savedTip}>
                                已存 — 之後新增 {def.short} 會直接套用
                            </span>
                        )}
                        {!isNew && <Button size="compact" variant="destructive"
                            className={styles.dangerBtn}
                            onClick={onRemove}
                        >
                            從圖表移除
                        </Button>}
                    </div>
                    <div className={styles.footerActions}>
                        <Button size="compact" variant="outline"
                            className={styles.cancelBtn}
                            onClick={onCancel}
                        >
                            取消
                        </Button>
                        <Button size="compact" variant="default" className={styles.okBtn} onClick={onCommit}>
                            {isNew ? '加入圖表' : '儲存修改'}
                        </Button>
                    </div>
                </div>

        </TerminalDialog>
    );
}
