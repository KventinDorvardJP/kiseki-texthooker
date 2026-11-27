import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createTitdb, maxLineLength, RateLimit } from './titdb.js';

const host = '127.0.0.1';
const port = Number(process.env.PORT || 8765);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');

const localOrigin = `http://${host}:${port}`;
const titdb = createTitdb();
const assets = new Map(await Promise.all([
  ['/', 'index.html', 'text/html'],
  ['/app.js', 'app.js', 'text/javascript'],
  ['/capture.js', 'capture.js', 'text/javascript'],
  ['/style.css', 'style.css', 'text/css'],
].map(async ([route, file, type]) => [route, {
  data: await readFile(new URL(`./web/${file}`, import.meta.url)), type,
}])));

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

const server = createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self' ws://127.0.0.1:* wss://127.0.0.1:* ws://localhost:* wss://localhost:* ws://[::1]:* wss://[::1]:*; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  if (request.headers.host !== `${host}:${port}` || request.headers['sec-fetch-site'] === 'cross-site') {
    return json(response, 403, { status: 'forbidden' });
  }
  const { method, url } = request;
  const asset = method === 'GET' && assets.get(url);
  if (asset) {
    response.writeHead(200, { 'Content-Type': `${asset.type}; charset=utf-8`, 'Cache-Control': 'no-cache' });
    return response.end(asset.data);
  }

  try {
    if (method === 'GET' && url === '/api/games') return json(response, 200, await titdb.games());
    if (method === 'POST' && url === '/api/lookup') {
      if (request.headers.origin !== localOrigin) return json(response, 403, { status: 'forbidden' });
      let body = '';
      request.setEncoding('utf8');
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 16384) return json(response, 413, { status: 'invalid' });
      }
      let input;
      try { input = JSON.parse(body); } catch { return json(response, 400, { status: 'invalid' }); }
      if (!Number.isSafeInteger(input?.gameId) || input.gameId < 1 || typeof input.text !== 'string'
          || !input.text.trim() || input.text.length > maxLineLength
          || (input.source !== undefined && input.source !== 'agent' && input.source !== 'luna')
          || (input.previousText !== undefined && (typeof input.previousText !== 'string'
            || !input.previousText.trim() || input.previousText.length > maxLineLength))) {
        return json(response, 400, { status: 'invalid' });
      }
      return json(response, 200, await titdb.lookup(input.gameId, input.text, input.source, input.previousText));
    }
    return json(response, 404, { status: 'missing' });
  } catch (error) {
    if (error instanceof RateLimit) return json(response, 429, { status: 'busy' });
    return json(response, 503, { status: 'unavailable' });
  }
});

server.listen(port, host, () => console.log(`Kiseki Texthooker is running at ${localOrigin}`));
