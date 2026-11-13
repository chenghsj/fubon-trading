import { knownServerInfo } from './server-info-store';

export const FUBON_AUTOMATION_UNAVAILABLE = '富邦成交驅動的自動交易尚未支援；請手動管理部位，未建立自動停損停利保護';
export function isFubonBroker() { return knownServerInfo()?.broker === 'fubon'; }
