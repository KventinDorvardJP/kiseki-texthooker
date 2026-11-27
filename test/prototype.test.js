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
  engChrName: 'Hidden speaker',
};

function fixture(rows) {
  return createTitdb(async url => {
    if (url.pathname === '/api/game') return Response.json([{ id: 8, titleEng: 'Test game' }]);
    assert.equal(url.origin, 'https://trailsinthedatabase.com');
    assert.equal(url.pathname, '/api/script/search');
    assert.equal(url.searchParams.get('game_id'), '8');
    assert.equal(url.searchParams.get('strict_search'), 'true');
    assert.equal(url.searchParams.get('page_number'), '1');
    return Response.json(rows);
  });
}

test('Agent and LunaTranslator preserve multiline source text', () => {
  assert.equal(decodeCapture('agent', JSON.stringify({ sentence: japanese, speaker: 'Hidden' })), japanese);
  assert.equal(decodeCapture('agent', japanese), japanese);
  assert.equal(decodeCapture('agent', '{"type":"hello"}'), null);
  assert.equal(decodeCapture('luna', japanese), japanese);
  assert.throws(() => captureUrl('luna', 'ws://localhost:2333/api/ws/text/trans'), /origin/);
});

test('a complete Japanese span yields the database English alone', async () => {
  assert.deepEqual(await fixture([row]).lookup(8, japanese), { status: 'matched', english: row.engSearchText });
});

test('a partial search field cannot authorize a longer row', async () => {
  const fragment = '次の授業は';
  const longerRow = { ...row, jpnSearchText: fragment };
  assert.deepEqual(await fixture([longerRow]).lookup(8, fragment), { status: 'unmatched' });
});

test('multiple exact candidates and full result pages withhold English', async () => {
  assert.deepEqual(await fixture([row, { ...row, engSearchText: 'Magic is next.' }]).lookup(8, japanese), { status: 'ambiguous' });
  const partial = { ...row, jpnHtmlText: '次の授業は国語です。' };
  assert.deepEqual(await fixture([row, ...Array(23).fill(partial)]).lookup(8, japanese), { status: 'ambiguous' });
});

test('cross-game data is rejected', async () => {
  await assert.rejects(fixture([{ ...row, gameId: 1 }]).lookup(8, japanese), /Unexpected TITDB/);
});
