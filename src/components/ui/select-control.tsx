import { createContext, forwardRef, useContext, useId, useState, type ComponentPropsWithoutRef } from 'react';
import { cn } from '@/lib/utils';
import { useEscClose } from '@/hooks/use-esc-close';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from './select';

// String values are delivered directly. No synthetic native change events.
const EmptyOptionValue = createContext('');
type SelectControlProps = Omit<ComponentPropsWithoutRef<typeof SelectTrigger>, 'value' | 'defaultValue' | 'onChange'> & {
    value?: string | number; defaultValue?: string | number; onValueChange?: (value: string) => void;
    wrapperClassName?: string; name?: string; placeholder?: string;
};
export const SelectControl = forwardRef<HTMLButtonElement, SelectControlProps>(function SelectControl(
    { value, defaultValue, onValueChange, children, className, wrapperClassName, disabled, name, placeholder = '請選擇', ...props }, ref,
) {
    const empty = `empty-${useId()}`;
    const [open, setOpen] = useState(false);
    useEscClose(() => setOpen(false), open);
    const encode = (v: string | number | undefined) => v === undefined ? undefined : v === '' ? empty : String(v);
    return <EmptyOptionValue.Provider value={empty}>
        <Select open={open} onOpenChange={setOpen} value={encode(value)} defaultValue={encode(defaultValue)} onValueChange={v => onValueChange?.(v === empty ? '' : v)} disabled={disabled} name={name}>
            <div className={cn('relative w-fit min-w-0 max-w-full', wrapperClassName)} data-slot="select-wrapper">
                <SelectTrigger {...props} aria-label={props['aria-label'] ?? props.title} ref={ref} disabled={disabled} className={className}><SelectValue placeholder={placeholder} /></SelectTrigger>
            </div>
            <SelectContent><SelectGroup>{children}</SelectGroup></SelectContent>
        </Select>
    </EmptyOptionValue.Provider>;
});
export function SelectOption({ value, ...props }: Omit<ComponentPropsWithoutRef<typeof SelectItem>, 'value'> & { value: string | number }) {
    const empty = useContext(EmptyOptionValue);
    return <SelectItem value={value === '' ? empty : String(value)} {...props} />;
}
export function SelectOptionGroup({ label, children }: { label: string; children: React.ReactNode }) {
    return <SelectGroup><SelectLabel>{label}</SelectLabel>{children}</SelectGroup>;
}
