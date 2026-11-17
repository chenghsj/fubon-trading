export async function waitForFubonRestart(previous: string) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        try {
            const response = await fetch('/api/v1/passkeys/status', { signal: AbortSignal.timeout(1500), cache: 'no-store' });
            if (response.ok && (await response.json()).instance_id !== previous) { location.reload(); return; }
        } catch { /* The owned backend is restarting. */ }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('服務尚未完成重新連線，請重新整理確認狀態；不要重複儲存。');
}
