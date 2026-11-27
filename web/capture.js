export const sources = {
  agent: 'ws://127.0.0.1:9001',
  luna: 'ws://127.0.0.1:2333/api/ws/text/origin',
};

export function captureUrl(source, input) {
  const url = new URL(input);
  if (!['ws:', 'wss:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.hash) {
    throw new Error('Enter a local ws:// or wss:// address.');
  }
  if (source === 'luna' && url.pathname !== '/api/ws/text/origin') {
    throw new Error('Use LunaTranslator’s /api/ws/text/origin address.');
  }
  return url.href;
}

export function decodeCapture(source, frame) {
  if (typeof frame !== 'string' || !frame.trim() || frame.length > 16_000) return null;
  if (source === 'luna') return frame;
  if (!frame.trimStart().startsWith('{')) return frame;

  try {
    const { sentence } = JSON.parse(frame);
    return typeof sentence === 'string' && sentence.trim() ? sentence : null;
  } catch {
    return null;
  }
}
