import { canEnrollPasskey, sessionRequest } from './lib/fubon-session';
import { passkeysSupported, unlockWithPasskey } from './lib/passkeys';
import './passkey-gate.css';

export async function showPasskeyGate(onUnlocked: () => Promise<void>) {
    const root = document.getElementById('root');
    if (!root) return;
    document.body.style.margin = '0';
    const page = document.createElement('main'); page.className = 'passkey-page';
    const panel = document.createElement('section'); panel.className = 'passkey-panel';
    const brand = document.createElement('p'); brand.className = 'passkey-brand'; brand.textContent = 'FUBON TRADING / 本機交易終端';
    const mark = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    mark.setAttribute('viewBox', '0 0 24 24'); mark.setAttribute('fill', 'none'); mark.setAttribute('stroke', 'currentColor'); mark.setAttribute('stroke-width', '1.4'); mark.setAttribute('aria-hidden', 'true'); mark.classList.add('passkey-mark');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z M8.5 12l2.5 2.5 4.5-5'); mark.append(path);
    const title = document.createElement('h1'); title.textContent = '正在確認登入狀態';
    const copy = document.createElement('p'); copy.className = 'passkey-copy';
    const action = document.createElement('button'); action.type = 'button'; action.className = 'passkey-action'; action.hidden = true;
    const status = document.createElement('p'); status.className = 'passkey-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const notes = document.createElement('p'); notes.className = 'passkey-notes';
    notes.textContent = 'Passkey 用來解鎖本機介面。富邦登入資料保存在 Keychain，解鎖後由後端使用；不會傳入瀏覽器。';
    panel.append(brand, mark, title, copy, action, status, notes); page.append(panel); root.replaceChildren(page);
    if (location.hostname !== 'localhost') {
        title.textContent = '請使用本機登入網址'; copy.textContent = 'Passkey 綁定 localhost，請從啟動視窗進入。';
        const link = document.createElement('a'); link.className = 'passkey-link'; link.href = `http://localhost:${location.port}/`; link.textContent = '開啟 localhost 介面'; panel.insertBefore(link, status); return;
    }
    let enrolled = false;
    try {
        const result = await sessionRequest('/api/v1/passkeys/status');
        enrolled = result.enrolled === true;
    } catch {
        title.textContent = '尚未連上本機服務'; copy.textContent = '請執行 pnpm start，然後重新整理此頁面。'; return;
    }
    title.textContent = enrolled ? '使用 Passkey 解鎖' : '建立你的 Passkey';
    copy.textContent = enrolled ? '使用 Touch ID、裝置解鎖或安全金鑰驗證身分，進入交易介面。' : '首次設定後，即可使用 Passkey 解鎖，不必每次輸入登入資料。';
    if (!passkeysSupported()) { status.textContent = '此瀏覽器不支援 Passkey，請使用新版 Chrome、Safari 或 Edge 開啟啟動視窗。'; return; }
    if (!enrolled && !canEnrollPasskey()) { status.textContent = '首次設定需要啟動授權。請重新執行 pnpm start，使用自動開啟的視窗。'; return; }
    action.hidden = false; action.textContent = enrolled ? '使用 Passkey 解鎖' : '建立 Passkey 並解鎖';
    action.addEventListener('click', async () => {
        action.disabled = true; action.textContent = '等待裝置驗證…'; status.textContent = '';
        try { await unlockWithPasskey(!enrolled); await onUnlocked(); }
        catch (error) {
            // Registration can succeed before a delayed login/HTTP response fails.
            // Reconcile the server state rather than trapping the user in setup.
            try { enrolled = (await sessionRequest('/api/v1/passkeys/status')).enrolled === true; } catch { /* Keep the last known state. */ }
            title.textContent = enrolled ? '使用 Passkey 解鎖' : '建立你的 Passkey';
            status.textContent = error instanceof Error ? error.message : '驗證未完成，請重試。';
            action.disabled = false; action.textContent = enrolled ? '再次使用 Passkey 解鎖' : '再次建立 Passkey';
        }
    });
}
