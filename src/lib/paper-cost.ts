import { getContractFee } from './contract-fee';
import { knownServerInfo } from './server-info-store';

/** Include local costs only for the Fubon paper endpoint, never broker orders. */
export function paperCostPayload(contract: { code: string; security_type: string | null }) {
    const info = knownServerInfo(), product = contract.code.slice(0, 3);
    if (info?.broker !== 'fubon' || info.mode !== 'paper' || contract.security_type !== 'FUT' || !/^(TMF|MXF|TXF)$/.test(product)) return {};
    const fee = getContractFee(product);
    return { paper_cost: { fee_per_side: fee?.feePerSide ?? 20, tax_rate: .00002, fee_source: fee ? 'statement' : 'assumed' } };
}
