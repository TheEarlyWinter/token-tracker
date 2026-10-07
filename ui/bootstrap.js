import { hana } from './assets/sdk.js';

export async function startDashboard({ targetWindow = window, sdk = hana, load = () => import('./dashboard-app.js') } = {}) {
  try {
    const isAppSurface = targetWindow.location?.pathname?.startsWith('/api/apps/token-tracker/ui/');
    if (targetWindow.parent && targetWindow.parent !== targetWindow && (targetWindow.hana || isAppSurface)) {
      targetWindow.hana ||= sdk;
      targetWindow.hana.ready();
    }
    await load();
    return true;
  } catch {
    const app = targetWindow.document.getElementById('app');
    if (app) app.textContent = '看板启动失败。请重新打开 Token 用量卡片；仍失败时检查插件安装与宿主版本。';
    return false;
  }
}

if (typeof window !== 'undefined') startDashboard();
