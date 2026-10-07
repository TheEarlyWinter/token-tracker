export async function copyDiagnostic(text, { sdk, browserClipboard } = {}) {
  try {
    if (sdk?.clipboard?.writeText) {
      await sdk.clipboard.writeText(text);
      return { ok: true, method: 'host' };
    }
    if (browserClipboard?.writeText) {
      await browserClipboard.writeText(text);
      return { ok: true, method: 'browser' };
    }
    return { ok: false, reason: 'unavailable' };
  } catch (error) {
    return { ok: false, reason: /PERMISSION|FORBIDDEN|DENIED|CAPABILITY/.test(String(error?.code || '').toUpperCase()) || error?.name === 'NotAllowedError' ? 'permission_denied' : 'failed' };
  }
}
