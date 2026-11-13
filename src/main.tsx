import './lib/polyfills';
import { prepareFubonSession } from './lib/fubon-session';

void prepareFubonSession().then(async authorized => {
    if (authorized) {
        await import('./terminal');
        return;
    }
    const root = document.getElementById('root');
    if (!root) return;
    const panel = document.createElement('main');
    panel.style.cssText = 'max-width:520px;margin:15vh auto;padding:32px;font:16px/1.8 system-ui;color:#e6e9ec;background:#171d24;border:1px solid #334155;border-radius:12px';
    document.body.style.cssText = 'margin:0;background:#101418';
    const title = document.createElement('h1');
    title.textContent = '請從啟動視窗進入';
    title.style.fontSize = '24px';
    const detail = document.createElement('p');
    detail.textContent = '此視窗尚未授權，或交易服務已重新啟動。請在終端機重新執行 pnpm start，並使用自動開啟的視窗。';
    const hint = document.createElement('p');
    hint.textContent = '授權完成後可重新整理頁面；關閉分頁或重啟服務後需要重新授權。';
    hint.style.color = '#94a3b8';
    panel.append(title, detail, hint);
    root.replaceChildren(panel);
});
