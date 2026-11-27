import assert from 'node:assert/strict';
import test from 'node:test';
import { createTitdb } from '../titdb.js';
import { captureUrl, decodeCapture } from '../web/capture.js';

const japanese = '次の授業は\n魔法です。';
const row = {
  gameId: 8,
  jpnSearchText: '次の授業は 魔法です。',
  jpnHtmlText: '次の授業は<br/><ruby>魔法<rt>まほう</rt></ruby>です。',
  engSearchText: 'Our next class is magic.',
  engChrName: ' Test speaker ',
  jpnChrName: '人物名',
};

function fixture(rows) {
  return createTitdb(async url => {
    if (url.pathname === '/api/game') return Response.json([{ id: 8, titleEng: 'Test game' }]);
    assert.equal(url.origin, 'https://trailsinthedatabase.com');
    assert.equal(url.pathname, '/api/script/search');
    assert.equal(url.searchParams.get('game_id'), '8');
    assert.equal(url.searchParams.get('strict_search'), 'true');
    assert.equal(url.searchParams.get('page_number'), '1');
    return Response.json(typeof rows === 'function' ? rows(url.searchParams.get('q')) : rows);
  });
}

test('Agent and LunaTranslator preserve multiline source text', () => {
  assert.equal(decodeCapture('agent', JSON.stringify({ sentence: japanese, speaker: 'Hidden' })), japanese);
  assert.equal(decodeCapture('agent', japanese), japanese);
  assert.equal(decodeCapture('agent', '{"type":"hello"}'), null);
  assert.equal(decodeCapture('luna', japanese), japanese);
  assert.throws(() => captureUrl('luna', 'ws://localhost:2333/api/ws/text/trans'), /origin/);
});

test('a complete Japanese span yields the database English and its English speaker name', async () => {
  assert.deepEqual(await fixture([row]).lookup(8, japanese), {
    status: 'matched', english: row.engSearchText, speaker: 'Test speaker',
  });

  const namelessRow = { ...row, engChrName: null };
  assert.deepEqual(await fixture([namelessRow]).lookup(8, japanese), { status: 'matched', english: row.engSearchText });
});

test('a partial search field cannot authorize a longer row', async () => {
  const fragment = '次の授業は';
  const longerRow = { ...row, jpnSearchText: fragment };
  assert.deepEqual(await fixture([longerRow]).lookup(8, fragment), { status: 'partial' });
});

const multilineRow = {
  ...row,
  jpnSearchText: '時計が午後３時を指している── 授業開始。',
  jpnHtmlText: '時計が午後３時を指している──<br/>授業開始。',
  engSearchText: 'It’s three in the afternoon. Class is starting.',
};

test('a second-line search finds a complete capture with a narrow digit and omitted dash', async () => {
  const queries = [];
  const database = fixture(query => {
    queries.push(query);
    return query === '授業開始。' ? [multilineRow] : [];
  });
  const result = await database.lookup(8, '時計が午後3時を指している\r\n授業開始。');
  assert.deepEqual(queries, ['時計が午後3時を指している', '授業開始。']);
  assert.deepEqual(result, { status: 'matched', english: multilineRow.engSearchText, speaker: 'Test speaker' });
  assert.deepEqual(await database.lookup(8, '授業開始。'), { status: 'partial' });
});

test('formatting tolerance preserves numeric values and inline dashes', async () => {
  assert.deepEqual(await fixture([multilineRow]).lookup(8, '時計が午後4時を指している\n授業開始。'), { status: 'unmatched' });
  const withInlineDash = { ...row, jpnHtmlText: '次の授業は──魔法です。' };
  assert.deepEqual(await fixture([withInlineDash]).lookup(8, '次の授業は魔法です。'), { status: 'unmatched' });
});

test('dot sequences match Japanese ellipses across a complete multiline capture', async () => {
  const dialogue = {
    ...row,
    jpnSearchText: '……そう、 鍵はまだ……',
    jpnHtmlText: '……そう、<br/>鍵はまだ……',
    engSearchText: 'Right... About the key...',
  };
  const database = fixture(query => {
    assert.equal(query, '鍵はまだ');
    return [dialogue, { ...row, jpnHtmlText: '鍵はまだ手元にあります。' }];
  });
  const capture = '......そう、\n鍵はまだ...';
  assert.deepEqual(await database.lookup(8, capture), {
    status: 'matched', english: dialogue.engSearchText, speaker: 'Test speaker',
  });
  assert.deepEqual(await fixture([dialogue]).lookup(8, '鍵はまだ...'), { status: 'partial' });

  const competingRow = { ...dialogue, jpnHtmlText: '…そう、<br/>鍵はまだ…', engSearchText: 'The key, then.' };
  assert.deepEqual(await fixture([dialogue, competingRow]).lookup(8, capture), { status: 'ambiguous' });
});

test('a single period stays distinct from an ellipsis', async () => {
  const dialogue = { ...row, jpnHtmlText: 'どうしよう……帰ろう。' };
  assert.deepEqual(await fixture([dialogue]).lookup(8, 'どうしよう.帰ろう。'), { status: 'unmatched' });
});

test('multiple exact candidates and full result pages withhold English', async () => {
  assert.deepEqual(await fixture([row, { ...row, engSearchText: 'Magic is next.' }]).lookup(8, japanese), { status: 'ambiguous' });
  const partial = { ...row, jpnHtmlText: '次の授業は国語です。' };
  assert.deepEqual(await fixture([row, ...Array(23).fill(partial)]).lookup(8, japanese), { status: 'ambiguous' });
});

test('cross-game data is rejected', async () => {
  await assert.rejects(fixture([{ ...row, gameId: 1 }]).lookup(8, japanese), /Unexpected TITDB/);
});
