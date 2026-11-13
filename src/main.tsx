// src/main.tsx

// polyfills MUST stay the first import — patches globals (structuredClone,
// AbortSignal.timeout, …) before any dependency module evaluates
import './lib/polyfills';
import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AppGate } from './app-gate';
import { AppErrorBoundary } from './components/app-error-boundary';
import './index.css';
import { startAnalytics } from './lib/analytics';
import { bootstrap } from './lib/boot';
import { initTheme } from './lib/theme-store';
import { startBackgroundExecution } from './lib/execution/background';

initTheme();
startAnalytics();
// Fubon fork: keep automatic entry/exit runtimes disabled until broker fill
// and deal-history conformance is verified. Manual trading remains available.
startBackgroundExecution(); // native-only; a no-op in this public Web build
bootstrap();
// #201 ③ dev only: `?mockPendingConfirm` shows fake 委託待確認 cards until the
// background engine implements the contract. Never part of a release build.
if (import.meta.env.DEV && new URLSearchParams(location.search).has('mockPendingConfirm')) {
    void import('./lib/execution/pending-confirm-dev').then(m => m.installMockPendingConfirm());
}

// #226 dev only: `?condDemo` fills the 條件單管理面板 with sample rows (no
// trigger, order or server state behind them). Never part of a release build.
if (import.meta.env.DEV && new URLSearchParams(location.search).has('condDemo')) {
    void import('./lib/conditional/demo-install').then(m => m.installConditionalDemo());
}

const rootElement = document.getElementById('root');
if (!rootElement) {
    throw new Error('Root element #root not found');
}

// Vite can re-evaluate this entry module during HMR. Keep the Root on the DOM
// node so a hot update renders into the existing tree instead of calling
// createRoot twice (which also duplicated background bootstrap side effects).
const rootHost = rootElement as HTMLElement & { __shioajiRoot?: Root };
const root = rootHost.__shioajiRoot ?? createRoot(rootHost);
rootHost.__shioajiRoot = root;
root.render(
    <StrictMode>
        <AppErrorBoundary>
            <AppGate />
        </AppErrorBoundary>
    </StrictMode>,
);
