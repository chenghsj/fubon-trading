import { useState } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import { TerminalDialog } from './terminal-dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { deleteMAGroup, saveMAGroup, type MAGroup } from '../lib/ma-groups';
import { MA_PRESETS, type MALinePreset } from '../lib/ma-presets';
import { IndicatorColorPicker } from './indicator-color-picker';
import * as styles from './indicator-dialog.css';

export function MAGroupEditor({ group, initialLines, onClose }: {
    group?: MAGroup; initialLines: MALinePreset[]; onClose: () => void;
}) {
    const [name, setName] = useState(group?.name ?? '');
    const [lines, setLines] = useState(() => structuredClone(group?.lines ?? initialLines));
    const [error, setError] = useState('');
    const patch = (index: number, value: Partial<MALinePreset>) => setLines(current => current.map((line, i) => i === index ? { ...line, ...value } : line));
    const save = () => {
        try { saveMAGroup({ ...(group ? { id: group.id } : {}), name, lines }); onClose(); }
        catch (error) { setError(error instanceof Error ? error.message : '無法儲存組合'); }
    };
    return <TerminalDialog title={group ? '編輯均線組合' : '建立均線組合'} onClose={onClose} layout="custom" className={styles.settingsDialog}>
        <div className={styles.header}>
            {group ? '編輯均線組合' : '建立均線組合'}
            <Button size="compact-icon" variant="ghost" aria-label="關閉均線組合" className={styles.closeBtn} onClick={onClose}><X size={16} /></Button>
        </div>
        <div className={styles.settingsBody}>
            <Label htmlFor="ma-group-name">組合名稱</Label>
            <Input id="ma-group-name" value={name} onChange={event => setName(event.target.value)} maxLength={30} placeholder="例如：我的均線組合" />
            <div className={styles.maPresetHint}>每條可選 1–500 期；以套用時的 K 棒時框計算。</div>
            <div className={styles.maPresetHint}>儲存或刪除組合不會變更已套用的圖表。</div>
            {lines.map((line, index) => <div key={index} className={styles.maGroupLine}>
                <Label htmlFor={`ma-group-period-${index}`}>MA</Label>
                <Input id={`ma-group-period-${index}`} aria-label={`第 ${index + 1} 條週期`} type="number" min={1} max={500} step={1}
                    value={Number.isNaN(line.period) ? '' : line.period} onChange={event => patch(index, { period: event.target.valueAsNumber })} />
                <IndicatorColorPicker label={`第 ${index + 1} 條顏色`} color={line.color} onChange={color => patch(index, { color })} />
                <Button size="compact-icon" variant="ghost" aria-label={`移除第 ${index + 1} 條均線`} className={styles.closeBtn}
                    disabled={lines.length === 1} onClick={() => setLines(current => current.filter((_, i) => i !== index))}><Trash2 size={14} /></Button>
            </div>)}
            <Button size="compact" variant="outline" disabled={lines.length >= 12} onClick={() => {
                const used = new Set(lines.map(line => line.period));
                const period = MA_PRESETS.find(p => !used.has(p.period))?.period ?? Array.from({ length: 500 }, (_, i) => i + 1).find(p => !used.has(p))!;
                setLines(current => [...current, { period, color: MA_PRESETS[current.length % MA_PRESETS.length]!.color }]);
            }}><Plus size={13} />新增均線</Button>
            {error && <div role="alert" className={styles.maGroupError}>{error}</div>}
        </div>
        <div className={styles.settingsFooter}>
            {group ? <Button size="compact" variant="ghost" className={styles.dangerBtn} onClick={() => {
                try { deleteMAGroup(group.id); onClose(); } catch (error) { setError(error instanceof Error ? error.message : '無法刪除組合'); }
            }}>刪除組合</Button> : <span />}
            <div className={styles.footerActions}>
                <Button size="compact" variant="outline" onClick={onClose}>取消</Button>
                <Button size="compact" onClick={save}>儲存組合</Button>
            </div>
        </div>
    </TerminalDialog>;
}
