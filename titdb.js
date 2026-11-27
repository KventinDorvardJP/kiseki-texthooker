const japanese = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const pageSize = 24;
export const maxLineLength = 1000;

export function searchTerm(text) {
  // The TITDB search switches to English for ASCII letters and certain punctuation.
  // Use a Japanese substring for discovery, then compare the entire row locally.
  const phrases = text.match(/[^\sa-zA-Z.,:;'%_\\]+/gu) ?? [];
  return phrases.filter(phrase => japanese.test(phrase)).sort((a, b) => b.length - a.length)[0] ?? '';
}

const normalize = text => text.normalize('NFC').replace(/\s/gu, '');
const entities = { amp: '&', apos: "'", quot: '"', lt: '<', gt: '>', nbsp: ' ' };

function dialogueFromMarkup(markup) {
  const text = markup
    .replace(/<(rt|rp)>[^<>]*<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(?:ruby|rb)>/gi, '');
  if (/[<>]/.test(text)) return null;
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, code) => {
    if (code[0] !== '#') return Object.hasOwn(entities, code) ? entities[code] : entity;
    const value = /^#x/i.test(code) ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
    return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : entity;
  });
}

function matchRows(rows, gameId, captured) {
  if (!Array.isArray(rows) || rows.some(row => row?.gameId !== gameId
      || typeof row.jpnHtmlText !== 'string' || typeof row.jpnSearchText !== 'string'
      || !(row.engSearchText === null || typeof row.engSearchText === 'string'))) {
    throw new Error('Unexpected TITDB search results');
  }
  if (rows.length >= pageSize) return { status: 'ambiguous' };

  const target = normalize(captured);
  const candidates = rows.filter(row => {
    const dialogue = dialogueFromMarkup(row.jpnHtmlText);
    return dialogue === null ? normalize(row.jpnSearchText) === target : normalize(dialogue) === target;
  });
  if (candidates.length > 1) return { status: 'ambiguous' };
  const candidate = candidates[0];
  if (!candidate || dialogueFromMarkup(candidate.jpnHtmlText) === null || !candidate.engSearchText?.trim()) {
    return { status: 'unmatched' };
  }
  return { status: 'matched', english: candidate.engSearchText.trim() };
}

export class RateLimit extends Error {}

export function createTitdb(fetcher = fetch) {
  const origin = 'https://trailsinthedatabase.com';
  const cache = new Map();
  const inFlight = new Map();
  let catalog;
  let catalogRequest;
  let cooldown = 0;

  async function getJson(path, params) {
    if (Date.now() < cooldown) throw new RateLimit();
    const url = new URL(path, origin);
    url.search = new URLSearchParams(params);
    const response = await fetcher(url, {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
    });
    if (response.status === 429) {
      const header = response.headers.get('retry-after');
      const delay = header && (/^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now());
      cooldown = Date.now() + (Number.isFinite(delay) ? Math.max(1000, delay) : 30_000);
      await response.body?.cancel();
      throw new RateLimit();
    }
    if (!response.ok || !/^application\/json\b/i.test(response.headers.get('content-type') ?? '')) {
      await response.body?.cancel();
      throw new Error('TITDB did not return JSON');
    }
    return response.json();
  }

  async function games() {
    if (catalog && catalog.expires > Date.now()) return catalog.games;
    catalogRequest ??= getJson('/api/game').then(rows => {
      if (!Array.isArray(rows) || !rows.length || rows.some(row => !Number.isSafeInteger(row?.id)
          || row.id < 1 || typeof row.titleEng !== 'string' || !row.titleEng.trim())) {
        throw new Error('Unexpected TITDB game catalog');
      }
      const games = rows.map(row => ({ id: row.id, title: row.titleEng }));
      catalog = { games, expires: Date.now() + 15 * 60_000 };
      return games;
    }).finally(() => { catalogRequest = undefined; });
    return catalogRequest;
  }

  async function lookup(gameId, text) {
    const q = searchTerm(text);
    if (!q) return { status: 'unmatched' };
    if (!(await games()).some(game => game.id === gameId)) return { status: 'unmatched' };

    const key = JSON.stringify([gameId, text]);
    const cached = cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.result;
    if (inFlight.has(key)) return inFlight.get(key);
    if (inFlight.size >= 2) throw new RateLimit();

    const search = term => getJson('/api/script/search', {
      q: term, game_id: gameId, strict_search: true, page_number: 1, page_size: pageSize,
    });
    const request = search(q).then(rows => {
      // Some hooks omit line breaks that TITDB stores as spaces in its search field.
      const prefix = q.slice(0, 12);
      return Array.isArray(rows) && !rows.length && q !== prefix && japanese.test(prefix) ? search(prefix) : rows;
    }).then(rows => {
      const result = matchRows(rows, gameId, text);
      cache.delete(key);
      if (cache.size >= 128) cache.delete(cache.keys().next().value);
      cache.set(key, { result, expires: Date.now() + (result.status === 'matched' ? 10 : 1) * 60_000 });
      return result;
    }).finally(() => inFlight.delete(key));

    inFlight.set(key, request);
    return request;
  }

  return { games, lookup };
}
