import { useEffect, useId, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { useProductSearch } from '../hooks/use-product-search';
import { ensureContract, primeContract } from '../lib/contracts-cache';
import { searchNavigationDirection } from '../lib/search-navigation';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { Popover, PopoverAnchor, PopoverContent } from './ui/popover';
import { AsyncStatus } from './async-status';
import { optionId, productIdentity, ProductSuggestionRow } from './product-suggestion-row';
import * as styles from './panel-product-search.css';

/** A panel/group symbol picker. Choosing a product never edits a watchlist. */
export function PanelProductSearch({ value, onChange, onSelect, label, className }: {
    value: string;
    onChange: (value: string) => void;
    onSelect: (code: string) => void;
    label: string;
    className: string;
}) {
    const [open, setOpen] = useState(false);
    const [busyVersion, setBusyVersion] = useState<number | null>(null);
    const [error, setError] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const anchorRef = useRef<HTMLSpanElement>(null);
    const rows = useRef(new Map<string, HTMLButtonElement>());
    const listId = useId();
    // The input stays mounted when the popup closes. Keep its composition and
    // submit lifetime intact; an empty query suppresses work while closed.
    const search = useProductSearch(open ? value : '', { limit: 10, progressive: true });
    const { suggestions, activeIdentity, setActiveIdentity } = search;
    const busy = busyVersion !== null && search.isCurrent(busyVersion);
    const activeIndex = Math.max(0, suggestions.findIndex(item => productIdentity(item) === activeIdentity));
    const active = suggestions[activeIndex];
    const renderedVersion = search.renderedVersion;

    useEffect(() => {
        if (open && active) rows.current.get(productIdentity(active))?.scrollIntoView?.({ block: 'nearest' });
    }, [open, active]);

    const close = () => {
        search.clear();
        setOpen(false);
    };

    const submit = async (picked = active) => {
        if (busy || search.isComposing() || !search.isCurrent(renderedVersion)) return;
        if (picked && search.isStale()) { search.retry(); return; }
        const code = picked?.code ?? value.trim().toUpperCase();
        if (!code) return;
        // A name must resolve to an actual result, never become a panel's pinned code.
        if (!picked && !/^[A-Z0-9]+!?$/.test(code)) { setError(true); return; }
        search.cancel();
        const version = search.currentVersion();
        setBusyVersion(version);
        setError(false);
        try {
            if (picked?.contract) primeContract(picked.contract);
            const contract = await ensureContract(code, picked?.security_type);
            if (!search.isCurrent(version)) return;
            onSelect(contract.code);
            onChange(contract.code);
            close();
        } catch {
            if (search.isCurrent(version)) setError(true);
        } finally {
            setBusyVersion(current => current === version ? null : current);
        }
    };

    return <Popover open={open} onOpenChange={next => {
        if (!next && search.isComposing()) return;
        if (next) setOpen(true); else close();
    }}>
        <PopoverAnchor asChild>
            <span ref={anchorRef} className={styles.anchor}>
                <Input ref={inputRef} className={className} value={value}
                    aria-label={label} title={`${label}：代碼或名稱，選取後直接切換`}
                    placeholder='代碼／名稱' role='combobox' aria-autocomplete='list'
                    aria-expanded={open} aria-controls={open ? listId : undefined}
                    aria-activedescendant={open && active ? optionId(listId, productIdentity(active)) : undefined}
                    onFocus={event => { setOpen(true); event.currentTarget.select(); }}
                    onClick={() => setOpen(true)}
                    onCompositionStart={() => { search.startComposition(); setError(false); }}
                    onCompositionEnd={event => { search.endComposition(); onChange(event.currentTarget.value); }}
                    onChange={event => {
                        search.change(event.target.value);
                        onChange(event.target.value);
                        setError(false);
                        setOpen(true);
                    }}
                    onKeyDown={event => {
                        const composing = search.isComposing() || event.nativeEvent?.isComposing;
                        const direction = searchNavigationDirection(event, composing);
                        if (direction && suggestions.length) {
                            event.preventDefault();
                            setActiveIdentity(productIdentity(suggestions[(activeIndex + direction + suggestions.length) % suggestions.length]!));
                            return;
                        }
                        if (composing || event.keyCode === 229) return;
                        if (event.key === 'Escape' && open) {
                            event.preventDefault(); event.stopPropagation(); close();
                        } else if (event.key === 'Enter') {
                            event.preventDefault(); void submit();
                        }
                    }} />
                <Search className={styles.icon} size={12} aria-hidden />
            </span>
        </PopoverAnchor>
        <PopoverContent align='end' className={styles.popup} aria-label={`${label}結果`}
            onOpenAutoFocus={event => event.preventDefault()}
            onCloseAutoFocus={event => event.preventDefault()}
            onEscapeKeyDown={event => { event.preventDefault(); if (!search.isComposing()) close(); }}
            onInteractOutside={event => {
                if (search.isComposing() || anchorRef.current?.contains(event.target as Node)) event.preventDefault();
            }}>
            <div className={styles.hint}>代碼、名稱、相關期貨 · 直接切換，不加入自選</div>
            <div className={styles.results} id={listId} role='listbox' aria-label={`${label}搜尋結果`}>
                {suggestions.map((item, index) => {
                    const identity = productIdentity(item);
                    return <ProductSuggestionRow key={identity} item={item} id={optionId(listId, identity)}
                        active={index === activeIndex} className={styles.result} disabled={busy}
                        rowRef={node => { if (node) rows.current.set(identity, node); else rows.current.delete(identity); }}
                        onSelect={() => submit(item)} />;
                })}
            </div>
            <div className={styles.hint}>
                <AsyncStatus phase={busy || search.searching ? 'loading' : error || search.searchError ? 'error' : 'idle'}
                    text={busy ? '切換商品中…' : error ? '找不到此商品，請選取搜尋結果' : search.searchError ? '搜尋失敗，可重試' : search.searching ? '搜尋中…' : suggestions.length ? '↑↓ / Ctrl+N、P 選擇 · Enter 切換 · Esc 關閉' : value.trim() ? '沒有符合的商品' : '輸入股票或期貨的代碼／名稱'}
                    action={error || search.searchError ? <Button size='compact' variant='ghost' type='button'
                        onMouseDown={event => event.preventDefault()} onClick={() => {
                            setError(false); search.retry(); inputRef.current?.focus();
                        }}>重試</Button> : undefined} />
            </div>
        </PopoverContent>
    </Popover>;
}
