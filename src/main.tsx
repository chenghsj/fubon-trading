import './lib/polyfills';
import { prepareFubonSession } from './lib/fubon-session';

const openTerminal = async () => { await import('./terminal'); };
void prepareFubonSession().then(async authorized => {
    if (authorized) await openTerminal();
    else {
        const { showPasskeyGate } = await import('./passkey-gate');
        await showPasskeyGate(openTerminal);
    }
});
