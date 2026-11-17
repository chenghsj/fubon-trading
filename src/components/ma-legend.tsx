import { ArrowDown, ArrowUp, ChevronDown, Copy, Eye, EyeOff, Settings2, Star, X } from 'lucide-react';
import type { MaDirection } from '../lib/ma-readout';
import { Button } from './ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
    DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from './ui/dropdown-menu';
import * as styles from './ma-legend.css';

export interface MaLegendItem {
    id: string;
    period: number;
    color: string;
    text: string;
    direction: MaDirection;
    hidden?: boolean;
    offTf: boolean;
    showValues: boolean;
    first: boolean;
    last: boolean;
}
interface MaLegendProps {
    items: MaLegendItem[];
    maxWidth: number;
    onSettings: (id: string) => void;
    onToggle: (id: string) => void;
    onRemove: (id: string) => void;
    onDuplicate: (id: string) => void;
    onMove: (id: string, delta: -1 | 1) => void;
    onFavorite: () => void;
}
const directionLabel = (direction: MaDirection) => direction === 1 ? '上升' : direction === -1 ? '下降' : direction === 0 ? '持平' : '';

export function MaLegend({ items, maxWidth, onSettings, onToggle, onRemove, onDuplicate, onMove, onFavorite }: MaLegendProps) {
    if (!items.length) return null;
    return <div className={styles.row} style={{ maxWidth }} role="group" aria-label="移動平均線" data-ma-legend="row">
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button size="compact" variant="ghost" className={styles.menuTrigger} aria-label="管理移動平均線" title="管理移動平均線">MA<ChevronDown size={10} aria-hidden="true" /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" aria-label="管理移動平均線">
                <DropdownMenuLabel>移動平均線</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {items.map(item => <DropdownMenuSub key={item.id}>
                    <DropdownMenuSubTrigger style={{ color: item.color }}>MA({item.period}){item.hidden ? ' · 已隱藏' : item.offTf ? ' · 此時框停用' : ''}</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                        <DropdownMenuItem onSelect={() => onSettings(item.id)}><Settings2 />設定…</DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => onToggle(item.id)}>{item.hidden ? <EyeOff /> : <Eye />}{item.hidden ? '顯示' : '隱藏'}</DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => onDuplicate(item.id)}><Copy />複製指標</DropdownMenuItem>
                        <DropdownMenuItem disabled={item.first} onSelect={() => onMove(item.id, -1)}><ArrowUp />上移（視覺順序）</DropdownMenuItem>
                        <DropdownMenuItem disabled={item.last} onSelect={() => onMove(item.id, 1)}><ArrowDown />下移（視覺順序）</DropdownMenuItem>
                        <DropdownMenuItem onSelect={onFavorite}><Star />加入 / 移除我的最愛</DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem className={styles.remove} onSelect={() => onRemove(item.id)}><X />移除</DropdownMenuItem>
                    </DropdownMenuSubContent>
                </DropdownMenuSub>)}
            </DropdownMenuContent>
        </DropdownMenu>
        <div className={styles.values} tabIndex={0} role="group" aria-label="均線數值，可左右捲動">
            {items.map(item => {
                const dimmed = item.hidden || item.offTf;
                const showValue = !dimmed && item.showValues;
                const label = `MA(${item.period})${item.hidden ? ' 已隱藏' : item.offTf ? ' 此時框停用' : showValue ? ` ${item.text} ${directionLabel(item.direction)}` : ''}`;
                return <button key={item.id} type="button" className={styles.item} style={{ color: item.color }}
                    data-ma-period={item.period} data-dimmed={!!dimmed} aria-label={label} title={`${label}；點擊設定`}
                    onClick={() => onSettings(item.id)}>
                    <span>({item.period})</span>
                    {showValue && <><span>{item.text}</span>{item.direction !== null && <span className={styles.direction} data-direction={item.direction}
                        data-ma-direction={item.direction} aria-hidden="true">{item.direction === 1 ? '▲' : item.direction === -1 ? '▼' : '→'}</span>}</>}
                </button>;
            })}
        </div>
    </div>;
}
