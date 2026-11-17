import { Copy, Eye, EyeOff, GripVertical, MoreHorizontal, Settings2, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { motion, MotionConfig, Reorder, useDragControls, useReducedMotion, type DragControls } from 'motion/react';
import { useEscClose } from '../hooks/use-esc-close';
import { DEF_BY_TYPE, instanceLabel, outputStyle, type IndicatorInstance } from '../lib/indicator-defs';
import { Button } from './ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu';
import * as styles from './indicator-manager.css';

export interface IndicatorManagement {
    timeframe: number;
    onSettings: (id: string) => void;
    onToggle: (id: string) => void;
    onReorder: (id: string, order: readonly string[]) => void;
    onDuplicate: (id: string) => void;
    onRemove: (id: string) => void;
}

export function IndicatorManager({ instances, management, onAdd }: {
    instances: IndicatorInstance[];
    management: IndicatorManagement;
    onAdd: () => void;
}) {
    const [menuFor, setMenuFor] = useState<string | null>(null);
    const [draft, setDraft] = useState<ReorderDraft | null>(null);
    const frame = useRef<ReorderDraft | null>(null);
    const epoch = useRef(0);
    const current = useRef(instances);
    current.current = instances;
    const [announcement, setAnnouncement] = useState('');
    const overlayRows = useRef<HTMLUListElement>(null);
    const paneRows = useRef<HTMLUListElement>(null);
    const finish = (cancel = false, expectedEpoch?: number) => {
        const gesture = frame.current;
        if (!gesture || (expectedEpoch !== undefined && gesture.epoch !== expectedEpoch)) return;
        frame.current = null;
        setDraft(null);
        // Stop Motion after revoking the frame so its deferred drag-end callback
        // cannot commit a cancelled gesture. Snap back uses the same animation.
        if (cancel) gesture.controls?.stop();
        if (!cancel && gesture.base === current.current) {
            management.onReorder(gesture.id, gesture.order);
            setAnnouncement(`已完成排序，第 ${gesture.order.indexOf(gesture.id) + 1} 個位置`);
        } else setAnnouncement('已取消排序');
    };
    useEscClose(() => setMenuFor(null), menuFor !== null);
    useEscClose(() => finish(true), draft !== null);
    useEffect(() => {
        if (frame.current && frame.current.base !== instances) finish(true);
    }, [instances]);
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const cancel = () => finish(true);
        window.addEventListener('blur', cancel);
        return () => {
            window.removeEventListener('blur', cancel);
            const gesture = frame.current;
            frame.current = null;
            gesture?.controls?.cancel();
        };
    }, []);
    const start = (instance: IndicatorInstance, category: 'overlay' | 'pane', controls?: DragControls) => {
        if (frame.current) return;
        const order = instances.filter(item => DEF_BY_TYPE.get(item.type)?.category === category).map(item => item.id);
        const next = { id: instance.id, epoch: ++epoch.current, category, base: instances, order, controls };
        frame.current = next;
        setDraft(next);
        setMenuFor(null);
        setAnnouncement(`已拿起 ${instanceLabel(instance)}，第 ${order.indexOf(instance.id) + 1} 個位置`);
    };
    const preview = (order: string[]) => {
        const gesture = frame.current;
        if (!gesture || gesture.base !== current.current) return;
        const next = { ...gesture, order };
        frame.current = next;
        setDraft(next);
        setAnnouncement(`第 ${order.indexOf(gesture.id) + 1} 個位置，共 ${order.length} 個`);
    };
    const keyReorder = (event: KeyboardEvent, instance: IndicatorInstance, category: 'overlay' | 'pane') => {
        const gesture = frame.current;
        if (gesture?.controls) return;
        if (event.key === ' ' || event.key === 'Enter') {
            event.preventDefault();
            if (event.repeat) return;
            if (!gesture) start(instance, category);
            else if (gesture.id === instance.id) finish();
        } else if (gesture?.id === instance.id && !gesture.controls && ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            const order = [...gesture.order];
            const from = order.indexOf(instance.id);
            const to = event.key === 'Home' ? 0 : event.key === 'End' ? order.length - 1
                : Math.max(0, Math.min(order.length - 1, from + (event.key === 'ArrowUp' ? -1 : 1)));
            order.splice(from, 1); order.splice(to, 0, instance.id);
            preview(order);
        }
    };
    if (!instances.length) return <div className={styles.empty}>
        <p>這張圖還沒有指標</p>
        <Button variant="outline" size="compact" onClick={onAdd}>新增指標</Button>
    </div>;
    return <MotionConfig reducedMotion="user"><motion.div layoutScroll className={styles.list}>
        {(['overlay', 'pane'] as const).map(category => {
            const group = instances.filter(instance => DEF_BY_TYPE.get(instance.type)?.category === category);
            if (!group.length) return null;
            const order = draft?.base === instances && draft.category === category ? draft.order : group.map(item => item.id);
            return <section key={category} aria-label={category === 'pane' ? '已加入的副圖指標' : '已加入的主圖指標'}>
                <h3 className={styles.heading}>{category === 'pane' ? '副圖指標' : '主圖疊加'}<span>{group.length}</span></h3>
                <Reorder.Group ref={category === 'pane' ? paneRows : overlayRows} axis="y" values={order} onReorder={preview} className={styles.rows}>
                    {order.map(id => {
                        const instance = group.find(item => item.id === id)!;
                        const def = DEF_BY_TYPE.get(instance.type)!;
                        const label = instanceLabel(instance);
                        const offTf = !!instance.visibleTf && !instance.visibleTf.includes(management.timeframe);
                        return <SortableIndicator key={instance.id} instance={instance} disabled={group.length < 2 || !!draft && draft.id !== instance.id}
                            bounds={category === 'pane' ? paneRows : overlayRows}
                            epoch={draft?.id === instance.id ? draft.epoch : undefined}
                            active={draft?.id === instance.id && draft.base === instances}
                            onStart={controls => start(instance, category, controls)} onFinish={(epoch, cancel) => finish(cancel, epoch)}
                            onKeyDown={event => keyReorder(event, instance, category)}>
                            <span className={styles.swatch} style={{ background: outputStyle(instance, def, def.outputs[0]!.key).color }} aria-hidden="true" />
                            <Button size="compact" variant="ghost" className={styles.name} onClick={() => management.onSettings(instance.id)} aria-label={`${label} 設定`}>
                                <span className={styles.label}>{label}<Settings2 size={12} aria-hidden="true" /></span>
                                <span className={styles.description}>{instance.hidden ? '已隱藏' : offTf ? '此時框停用' : label === def.label ? '獨立副圖' : def.label}</span>
                            </Button>
                            <div className={styles.actions}>
                                <Button size="compact-icon" variant="ghost" className={styles.action} aria-label={`${label} ${instance.hidden ? '顯示' : '隱藏'}`} title={instance.hidden ? '顯示' : '隱藏'}
                                    onClick={() => management.onToggle(instance.id)}>{instance.hidden ? <EyeOff size={15} /> : <Eye size={15} />}</Button>
                                <DropdownMenu open={menuFor === instance.id} onOpenChange={open => setMenuFor(current => open ? instance.id : current === instance.id ? null : current)}>
                                    <DropdownMenuTrigger asChild><Button size="compact-icon" variant="ghost" className={styles.action} aria-label={`${label} 更多操作`} title="更多操作"><MoreHorizontal size={15} /></Button></DropdownMenuTrigger>
                                    <DropdownMenuContent align="end">
                                        <DropdownMenuGroup>
                                        <DropdownMenuItem onSelect={() => management.onSettings(instance.id)}><Settings2 />設定…</DropdownMenuItem>
                                        <DropdownMenuItem onSelect={() => management.onDuplicate(instance.id)}><Copy />複製指標</DropdownMenuItem>
                                        </DropdownMenuGroup>
                                        <DropdownMenuSeparator />
                                        <DropdownMenuGroup>
                                        <DropdownMenuItem className={styles.remove} onSelect={() => management.onRemove(instance.id)}><Trash2 />移除</DropdownMenuItem>
                                        </DropdownMenuGroup>
                                    </DropdownMenuContent>
                                </DropdownMenu>
                            </div>
                        </SortableIndicator>;
                    })}
                </Reorder.Group>
            </section>;
        })}
        <p className={styles.hint}>拖曳左側把手調整同類指標順序，放開儲存。點名稱修改設定。</p>
        <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
    </motion.div></MotionConfig>;
}


interface ReorderDraft {
    id: string;
    epoch: number;
    category: 'overlay' | 'pane';
    base: IndicatorInstance[];
    order: string[];
    controls?: DragControls;
}

function SortableIndicator({ instance, active, disabled, bounds, epoch, onStart, onFinish, onKeyDown, children }: {
    instance: IndicatorInstance;
    active: boolean;
    disabled: boolean;
    bounds: RefObject<HTMLUListElement | null>;
    epoch?: number;
    onStart: (controls: DragControls) => void;
    onFinish: (epoch: number, cancel?: boolean) => void;
    onKeyDown: (event: KeyboardEvent) => void;
    children: ReactNode;
}) {
    const controls = useDragControls();
    const reduced = useReducedMotion();
    const row = useRef<HTMLLIElement>(null);
    return <Reorder.Item ref={row} value={instance.id} dragListener={false} dragControls={controls} dragMomentum={false}
        dragConstraints={bounds} dragElastic={0}
        onMeasureDragConstraints={() => {
            const element = row.current;
            const group = bounds.current;
            if (!element || !group) return;
            // Motion's viewport bounds include the scroll offset, but its
            // layout box excludes it. Measure both ends in the group's own
            // layout coordinates so a scrolled list keeps its full drag range.
            return { top: -element.offsetTop, bottom: Math.max(0, group.clientHeight - element.offsetTop - element.offsetHeight), left: 0, right: 0 };
        }}
        className={styles.row} data-managed-indicator={instance.id} data-indicator-dragging={active || undefined}
        transition={{ layout: reduced ? { duration: 0 } : { type: 'spring', stiffness: 420, damping: 34 } }}
        onDragStart={() => onStart(controls)} onDragEnd={event => { if (epoch !== undefined) onFinish(epoch, event.type === 'pointercancel'); }}>
        <Button size="compact-icon" variant="ghost" className={styles.grip} disabled={disabled}
            data-reorder-handle={instance.id}
            aria-label={`${instanceLabel(instance)} 拖曳排序`} aria-pressed={active}
            title="拖曳排序；或按空白鍵拿起、上下鍵移動、Enter 完成、Esc 取消"
            onKeyDown={onKeyDown} onPointerDown={event => {
                if (event.button !== 0 || !event.isPrimary || disabled || active) return;
                event.currentTarget.focus();
                controls.start(event);
            }}><GripVertical size={16} /></Button>
        {children}
    </Reorder.Item>;
}
