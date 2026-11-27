const japanese = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const inlineDialoguePause = new RegExp(`(?<=${japanese.source})──(?=${japanese.source})`, 'gu');
const pageSize = 24;
const cacheLimit = 20;
const coldSteelIII = 8;
const boxBreak = /<br\s*\/?>\s*<br\s*\/?>/gi;
const coldSteelIIIVoiceLink = /<a href="javascript:void\(0\)" class="dialogue-line" data-audio="talk\/8\/[\w.-]+\.opus">([\s\S]*?)<\/a>/gu;
export const maxLineLength = 1000;

function searchTerms(text) {
  // The TITDB search switches to English for ASCII letters and certain punctuation.
  // Use a Japanese substring for discovery, then compare the entire row locally.
  const phrases = text.match(/[^\sa-zA-Z.,:;'%_\\]+/gu) ?? [];
  return phrases.filter(phrase => japanese.test(phrase)).sort((a, b) => b.length - a.length);
}

function ocrAnchors(phrase) {
  const characters = [...phrase.replace(/[。！？!?]+$/u, '')];
  const anchorLength = 10;
  if (characters.length <= anchorLength) return [];
  return [characters.slice(0, anchorLength).join(''), characters.slice(-anchorLength).join('')];
}

const toNarrow = character => character.normalize('NFKC');
const toWide = character => String.fromCharCode(character.charCodeAt(0) + 0xfee0);
// Cold Steel III's heart glyph can be extracted as the single CP932 character ㈱.
const fixColdSteelIIIHeart = text => text.replaceAll('㈱', '♥');

function normalize(text) {
  // Some captures omit dialogue dashes just before a line break. Keep inline dashes.
  const withoutLineEndDashes = text.replace(/[—―─]+(?=[^\S\r\n]*(?:\r\n?|\n|$))/gu, '');
  return withoutLineEndDashes.normalize('NFC').replace(/[０-９？！]/gu, toNarrow)
    .replace(/…+|[.．]{3,}/gu, '…')
    .replace(/\s/gu, '');
}

const entities = { amp: '&', apos: "'", quot: '"', lt: '<', gt: '>', nbsp: ' ' };

function dialogueFromMarkup(markup) {
  const text = markup
    .replace(coldSteelIIIVoiceLink, '$1')
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

function splitAgentCapture(text) {
  const [firstLine, ...rest] = text.split(/\r\n?|\n/u);
  const speaker = firstLine.trim().normalize('NFC');
  return speaker && rest.length ? { speaker, dialogue: rest.join('\n') } : null;
}

function comparisonCapture(text, agentCapture, isLuna = false) {
  const normalized = normalize(text);
  const targets = [normalized];
  if (isLuna) {
    // OCR can drop an opening pause while retaining all spoken text.
    if (!normalized.startsWith('…')) targets.push('…' + normalized);
    if (!normalized.startsWith('──')) targets.push('──' + normalized);
  }
  return {
    targets,
    dialogue: agentCapture && normalize(agentCapture.dialogue),
    speaker: agentCapture?.speaker,
  };
}

function matchesCapturedSpeaker(row, capture) {
  return capture.dialogue && typeof row.jpnChrName === 'string'
    && row.jpnChrName.trim().normalize('NFC') === capture.speaker;
}

function targetsForSpeaker(row, capture) {
  return matchesCapturedSpeaker(row, capture) ? [...capture.targets, capture.dialogue] : capture.targets;
}

function matchesDialogue(text, targets, allowMissingPause) {
  if (targets.includes(text)) return true;
  if (!allowMissingPause || !targets.some(target => target.length === text.length - 2)) return false;
  for (const { index } of text.matchAll(inlineDialoguePause)) {
    if (targets.includes(text.slice(0, index) + text.slice(index + 2))) return true;
  }
  return false;
}

function japaneseBoxes(row) {
  return row.jpnHtmlText.split(boxBreak).map(box => normalize(dialogueFromMarkup(box) ?? ''));
}

function matchingBoxes(dialogues, allowMissingPause) {
  return dialogues.flatMap(({ row, targets }) => {
    const boxes = japaneseBoxes(row);
    if (boxes.length < 2 || boxes.includes('')) return [];
    return boxes.flatMap((box, index) => matchesDialogue(box, targets, allowMissingPause)
      ? [{ row, index, count: boxes.length, previousBox: boxes[index - 1] }]
      : []);
  });
}

const compactSpaces = text => text.trim().replace(/\s+/gu, ' ');
const compactExclamations = text => compactSpaces(text)
  .replace(/\b[A-Z]{4,}(?=!)/gu, word => word.replace(/([A-Z])\1{2,}/gu, '$1$1'));

function boxLocalization({ row, index, count }) {
  if (typeof row.engHtmlText !== 'string') return null;
  const boxes = row.engHtmlText.split(boxBreak).map(box => compactSpaces(dialogueFromMarkup(box) ?? ''));
  if (boxes.length !== count || boxes.some(box => !box)) return null;
  if (boxes.join(' ') !== compactSpaces(row.engSearchText ?? '')) return null;
  return boxes[index];
}

function matched(row, english) {
  const speaker = typeof row.engChrName === 'string' ? row.engChrName.trim() : '';
  return { status: 'matched', english, ...(speaker && { speaker }) };
}

function agreedMatch(candidates, compareEnglish = compactSpaces) {
  const first = candidates[0]?.result;
  if (!first) return null;
  const english = compareEnglish(first.english);
  return candidates.every(({ result }) => result && result.speaker === first.speaker
    && compareEnglish(result.english) === english) ? first : null;
}

function validateRows(rows, gameId) {
  if (!Array.isArray(rows) || rows.some(row => row?.gameId !== gameId
      || typeof row.jpnHtmlText !== 'string' || typeof row.jpnSearchText !== 'string'
      || !(row.engSearchText === null || typeof row.engSearchText === 'string'))) {
    throw new Error('Unexpected TITDB search results');
  }
}

function rowsEndingWithCapture(rows, gameId, capture) {
  validateRows(rows, gameId);
  if (rows.length >= pageSize) return [];
  return rows.filter(row => {
    const boxes = japaneseBoxes(row);
    if (boxes.includes('')) return false;
    const targets = targetsForSpeaker(row, capture);
    return targets.includes(boxes.at(-1)) || targets.includes(boxes.join(''));
  });
}

function followsInScene(row, previousRow) {
  return typeof row.fname === 'string' && Boolean(row.fname) && row.fname === previousRow.fname
    && typeof row.scene === 'string' && Boolean(row.scene) && row.scene === previousRow.scene
    && Number.isSafeInteger(previousRow.row) && Number.isSafeInteger(row.row) && row.row === previousRow.row + 1;
}

async function matchRows(rows, gameId, capture, { previousCapture, findPreviousRows, allowStandalone, allowMissingPause }) {
  validateRows(rows, gameId);
  if (rows.length >= pageSize) return { status: 'ambiguous' };

  const dialogues = rows.map(row => {
    const dialogue = dialogueFromMarkup(row.jpnHtmlText);
    return {
      row,
      fullText: dialogue === null ? null : normalize(dialogue),
      targets: targetsForSpeaker(row, capture),
    };
  });
  const candidates = dialogues.filter(({ row, fullText, targets }) =>
    matchesDialogue(fullText ?? normalize(row.jpnSearchText), targets, allowMissingPause));
  const partials = dialogues.filter(({ fullText, targets }) => targets.some(text => fullText?.includes(text)));
  // Cold Steel III's extractor preserves the game's textbox breaks in both languages.
  const boxes = gameId === coldSteelIII ? matchingBoxes(allowMissingPause ? dialogues : partials, allowMissingPause) : [];
  const matches = [
    ...candidates.map(({ row, fullText }) => ({
      row,
      startsRow: true,
      result: fullText && row.engSearchText?.trim() ? matched(row, row.engSearchText.trim()) : null,
    })),
    ...boxes.map(box => {
      const english = boxLocalization(box);
      return {
        row: box.row, startsRow: box.index === 0, previousBox: box.previousBox,
        result: english ? matched(box.row, english) : null,
      };
    }),
  ];
  const agreed = agreedMatch(matches);
  if (agreed) return agreed;
  if (matches.length > 1) {
    const ambiguous = { status: 'ambiguous' };
    const inContext = previousCapture ? matches.filter(({ row, previousBox }) => previousBox
      && targetsForSpeaker(row, previousCapture).includes(previousBox)) : [];
    if (inContext.length) return agreedMatch(inContext) ?? ambiguous;

    if (findPreviousRows && matches.some(({ startsRow }) => startsRow)) {
      const previousRows = await findPreviousRows();
      const adjacent = matches.filter(({ row, startsRow }) => startsRow
        && previousRows.some(previousRow => followsInScene(row, previousRow)));
      if (adjacent.length) return agreedMatch(adjacent) ?? ambiguous;
    }

    // Use the whole-row spelling when the same speaker's alternatives only vary in stretched exclamations.
    if (allowStandalone && candidates.length === 1 && matches.every(({ row }) => matchesCapturedSpeaker(row, capture))) {
      return agreedMatch(matches, compactExclamations) ?? ambiguous;
    }
    return ambiguous;
  }
  if (!candidates.length && partials.length) return { status: 'partial' };
  return { status: 'unmatched' };
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

  async function lookup(gameId, text, source, previousText) {
    const coldSteelIIIAgent = source === 'agent' && gameId === coldSteelIII;
    const lookupText = coldSteelIIIAgent ? fixColdSteelIIIHeart(text) : text;
    const [q, ...otherTerms] = searchTerms(lookupText);
    if (!q) return { status: 'unmatched' };
    if (!(await games()).some(game => game.id === gameId)) return { status: 'unmatched' };

    const agentCapture = source === 'agent' ? splitAgentCapture(lookupText) : null;
    const capture = comparisonCapture(lookupText, agentCapture, source === 'luna');
    const previousLookupText = coldSteelIIIAgent && previousText ? fixColdSteelIIIHeart(previousText) : null;
    const previousAgentCapture = previousLookupText ? splitAgentCapture(previousLookupText) : null;
    const previousCapture = previousLookupText ? comparisonCapture(previousLookupText, previousAgentCapture) : null;
    const bodyTerms = agentCapture ? searchTerms(agentCapture.dialogue) : [];
    const searchUsedPrefix = bodyTerms.length > 0 && !bodyTerms.includes(q);
    const key = JSON.stringify([gameId, lookupText, source, previousCapture]);
    const cached = cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.result;
    if (inFlight.has(key)) return inFlight.get(key);
    if (inFlight.size >= 2) throw new RateLimit();

    const search = term => getJson('/api/script/search', {
      q: term, game_id: gameId, strict_search: true, page_number: 1, page_size: pageSize,
    });
    const [previousTerm] = searchTerms(previousAgentCapture?.dialogue ?? previousLookupText ?? '');
    let previousRowsRequest;
    const findPreviousRows = previousTerm ? () => previousRowsRequest ??= search(previousTerm)
      .then(rows => rowsEndingWithCapture(rows, gameId, previousCapture))
      .catch(() => []) : null;
    const matchOptions = {
      previousCapture, findPreviousRows, allowStandalone: coldSteelIIIAgent, allowMissingPause: source === 'luna',
    };
    const request = search(q).then(async rows => {
      const first = await matchRows(rows, gameId, capture, matchOptions);
      if (first.status === 'matched') return first;
      if (first.status === 'ambiguous') {
        // A broad search of the first line may only have found mentions of the speaker.
        if (rows.length < pageSize || !searchUsedPrefix) return first;
        const second = await matchRows(await search(bodyTerms[0]), gameId, capture, matchOptions);
        return second.status === 'unmatched' ? first : second;
      }

      // Use another part of the capture when the longest phrase differs on the site.
      // A shorter prefix also handles captures that join lines without spaces.
      const fullTextAlternatives = agentCapture && first.status === 'partial' ? [] : otherTerms;
      // OCR can join lines that TITDB indexes with a space after sentence punctuation.
      const ocrClauses = source === 'luna' ? searchTerms(q.replace(/[。！？!?]+(?=[\p{L}\p{N}])/gu, ' ')) : [];
      const alternatives = [
        ...ocrClauses,
        q.replace(/[!?]/gu, toWide), q.replace(/[！？]/gu, toNarrow),
        ...bodyTerms, ...fullTextAlternatives, q.replace(/[0-9]/gu, toWide), q.replace(/[０-９]/gu, toNarrow),
      ];
      if (!rows.length) alternatives.push([...q].slice(0, 12).join(''));
      const fallback = alternatives.find(term => term !== q && japanese.test(term));
      // Two short anchors can recover a flattened OCR wrap without needing its exact breakpoint.
      const retries = new Set([fallback, ...(source === 'luna' ? ocrAnchors(q) : [])]);
      let best = first;
      for (const term of retries) {
        if (!term || term === q || !japanese.test(term)) continue;
        const retryRows = await search(term);
        const result = await matchRows(retryRows, gameId, capture, matchOptions);
        if (result.status === 'matched') return result;
        if (result.status === 'ambiguous') {
          if (source !== 'luna' || retryRows.length < pageSize) return best.status === 'partial' ? best : result;
          if (best.status === 'unmatched') best = result;
        } else if (result.status === 'partial') best = result;
      }
      return best;
    }).then(result => {
      cache.delete(key);
      if (cache.size >= cacheLimit) cache.delete(cache.keys().next().value);
      cache.set(key, { result, expires: Date.now() + (result.status === 'matched' ? 10 : 1) * 60_000 });
      return result;
    }).finally(() => inFlight.delete(key));

    inFlight.set(key, request);
    return request;
  }

  return { games, lookup };
}
