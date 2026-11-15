import { useState } from 'react';
import { saveContractFee, useContractFee } from '../lib/contract-fee';
import { Button } from './ui/button';

export function ContractFeeNote({ product, value, disabled, onApply }: { product: string; value: number; disabled: boolean; onApply: (fee: number) => void }) {
    const profile = useContractFee(product);
    const [error, setError] = useState('');
    return <div>
        <p>{profile ? `${product} 個人費率：每口單邊 $${profile.feePerSide}，來回 $${profile.feePerSide * 2}，不含期交稅。來源：對帳單核對；設定保存在本機瀏覽器，委託與研究紀錄另保存當時成本。`
            : `${product} 尚未保存個人費率；目前手續費為試算假設。`}</p>
        {profile && value !== profile.feePerSide && <Button size="compact" variant="outline" disabled={disabled} onClick={() => onApply(profile.feePerSide)}>套用個人費率 ${profile.feePerSide}</Button>}
        <Button size="compact" variant="ghost" disabled={disabled || !Number.isFinite(value) || value < 0 || value > 1000 || profile?.feePerSide === value} onClick={() => {
            try { saveContractFee(product, value); setError(''); onApply(value); }
            catch (e) { setError(e instanceof Error ? e.message : String(e)); }
        }}>依對帳單保存費率</Button>
        {error && <p role="alert">{error}</p>}
    </div>;
}
