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

test('Agent removes a first-line speaker from comparison only when the row confirms it', async () => {
  const database = fixture([row]);
  const capture = '人物名\r\n' + japanese;
  const expected = { status: 'matched', english: row.engSearchText, speaker: 'Test speaker' };
  assert.deepEqual(await database.lookup(8, capture, 'agent'), expected);
  assert.deepEqual(await database.lookup(8, capture, 'luna'), { status: 'unmatched' });
  assert.deepEqual(await database.lookup(8, '別人の名前\n' + japanese, 'agent'), { status: 'unmatched' });
  assert.deepEqual(await database.lookup(8, '人物名\n次の授業は', 'agent'), { status: 'partial' });
  assert.deepEqual(await database.lookup(8, japanese, 'agent'), expected);
  assert.deepEqual(await database.lookup(8, '\n' + capture, 'agent'), { status: 'unmatched' });
});

test('Agent can retry with the dialogue when a long first line fills the result page', async () => {
  const speaker = 'とても長い登場人物名';
  const dialogue = 'はい。';
  const namedRow = { ...row, jpnChrName: speaker, jpnHtmlText: dialogue, jpnSearchText: dialogue };
  const queries = [];
  const database = fixture(query => {
    queries.push(query);
    return query === speaker ? Array(24).fill(row) : [namedRow];
  });
  assert.deepEqual(await database.lookup(8, speaker + '\n' + dialogue, 'agent'), {
    status: 'matched', english: row.engSearchText, speaker: 'Test speaker',
  });
  assert.deepEqual(queries, [speaker, dialogue]);
});

const boxedRow = {
  ...row,
  jpnSearchText: 'あのね、ちょっと聞いて。 まだ準備ができていないの。 もう少しだけ待ってね。',
  jpnHtmlText: 'あのね、ちょっと聞いて。<br/><br/>まだ準備が<br/>できていないの。<br/><br/>もう少しだけ待ってね。',
  engSearchText: 'Hey, listen. I’m still getting ready. Give me just a minute.',
  engHtmlText: 'Hey, listen.<br/><br/>I’m still getting<br/>ready.<br/><br/>Give me just a minute.',
};

test('a complete Cold Steel III textbox returns only its corresponding English', async () => {
  const database = fixture([boxedRow]);
  const expected = { status: 'matched', speaker: 'Test speaker' };
  assert.deepEqual(await database.lookup(8, '人物名\nまだ準備が\nできていないの。', 'agent'), {
    ...expected, english: 'I’m still getting ready.',
  });
  assert.deepEqual(await database.lookup(8, '人物名\nもう少しだけ待ってね。', 'agent'), {
    ...expected, english: 'Give me just a minute.',
  });
  assert.deepEqual(await database.lookup(8, '人物名\nまだ準備が', 'agent'), { status: 'partial' });
});

test('missing English textbox boundaries and competing boxes withhold English', async () => {
  const capture = '人物名\nもう少しだけ待ってね。';
  const unsplitEnglish = { ...boxedRow, engHtmlText: boxedRow.engSearchText };
  assert.deepEqual(await fixture([unsplitEnglish]).lookup(8, capture, 'agent'), { status: 'partial' });
  assert.deepEqual(await fixture([boxedRow, unsplitEnglish]).lookup(8, capture, 'agent'), { status: 'ambiguous' });
});

const repeatedBox = 'もう少しだけ待ってね。';
const standaloneBox = { ...row, jpnHtmlText: repeatedBox, jpnSearchText: repeatedBox };

test('a standalone row and a box that agree on English and speaker can return the shared line', async () => {
  const capture = '人物名\n' + repeatedBox;
  const sameEnglish = { ...standaloneBox, engSearchText: 'Give me just a minute.' };
  assert.deepEqual(await fixture([boxedRow, sameEnglish]).lookup(8, capture, 'agent'), {
    status: 'matched', speaker: 'Test speaker', english: 'Give me just a minute.',
  });
  const otherSpeaker = { ...sameEnglish, engChrName: 'Another speaker' };
  assert.deepEqual(await fixture([boxedRow, otherSpeaker]).lookup(8, capture, 'agent'), { status: 'ambiguous' });
});

test('the immediately preceding box resolves conflicting English for a repeated Japanese box', async () => {
  const capture = '人物名\n' + repeatedBox;
  const database = fixture([{ ...standaloneBox, engSearchText: 'Wait for me.' }, boxedRow]);
  assert.deepEqual(await database.lookup(8, capture, 'agent'), { status: 'ambiguous' });
  assert.deepEqual(await database.lookup(8, capture, 'agent', '人物名\nまだ準備が\nできていないの。'), {
    status: 'matched', speaker: 'Test speaker', english: 'Give me just a minute.',
  });
  assert.deepEqual(await database.lookup(8, capture, 'agent', '別人\nまだ準備が\nできていないの。'), { status: 'ambiguous' });
  assert.deepEqual(await database.lookup(8, capture, 'agent', '人物名\nあのね、ちょっと聞いて。'), { status: 'ambiguous' });
  assert.deepEqual(await database.lookup(8, capture, 'agent'), { status: 'ambiguous' });
});

test('Agent prefers one whole row when only the spelling of a stretched exclamation differs', async () => {
  const capture = '人物名\n' + repeatedBox;
  const boxed = {
    ...boxedRow,
    engSearchText: boxedRow.engSearchText + ' URRGH!',
    engHtmlText: boxedRow.engHtmlText + ' URRGH!',
  };
  const complete = { ...standaloneBox, engSearchText: 'Give me just a minute. URRRGH!' };
  const database = fixture([boxed, complete]);
  assert.deepEqual(await database.lookup(8, capture, 'agent'), {
    status: 'matched', speaker: 'Test speaker', english: complete.engSearchText,
  });
  assert.deepEqual(await database.lookup(8, capture, 'agent', '人物名\nまだ準備が\nできていないの。'), {
    status: 'matched', speaker: 'Test speaker', english: 'Give me just a minute. URRGH!',
  });
  assert.deepEqual(await database.lookup(8, repeatedBox, 'luna'), { status: 'ambiguous' });
  assert.deepEqual(await database.lookup(8, repeatedBox, 'agent'), { status: 'ambiguous' });

  const anotherComplete = { ...complete, engSearchText: 'Give me just a minute. URRGH!' };
  assert.deepEqual(await fixture([complete, anotherComplete]).lookup(8, capture, 'agent'), { status: 'ambiguous' });
});

test('LunaTranslator matches independently even if the previous OCR capture fits another candidate', async () => {
  const database = fixture([{ ...standaloneBox, engSearchText: 'Wait for me.' }, boxedRow]);
  const previousText = 'まだ準備が\nできていないの。';
  assert.deepEqual(await database.lookup(8, repeatedBox, 'agent', previousText), {
    status: 'matched', speaker: 'Test speaker', english: 'Give me just a minute.',
  });
  assert.deepEqual(await database.lookup(8, repeatedBox, 'luna', previousText), { status: 'ambiguous' });
  assert.deepEqual(await database.lookup(8, previousText, 'luna'), {
    status: 'matched', speaker: 'Test speaker', english: 'I’m still getting ready.',
  });
});

test('Agent resolves a repeated line after the final box of an adjacent row in the same scene', async () => {
  const previous = { ...boxedRow, fname: 'scene_file', scene: '3', row: 26 };
  const text = 'わかった、ありがとう。';
  const reply = {
    ...row, fname: previous.fname, scene: previous.scene, row: 27,
    jpnChrName: '別の人物', jpnHtmlText: text, jpnSearchText: text, engSearchText: 'All right, thanks.',
  };
  const otherReply = { ...reply, fname: 'other_file', engSearchText: 'I understand. Thank you.' };
  const capture = reply.jpnChrName + '\n' + text;
  const lastBox = '人物名\nもう少しだけ待ってね。';
  const queries = [];
  const database = fixture(query => {
    queries.push(query);
    return query === text ? [otherReply, reply] : [previous];
  });

  assert.deepEqual(await database.lookup(8, capture, 'agent', lastBox), {
    status: 'matched', speaker: 'Test speaker', english: reply.engSearchText,
  });
  assert.deepEqual(queries, [text, 'もう少しだけ待ってね。']);
  assert.deepEqual(await database.lookup(8, capture, 'agent'), { status: 'ambiguous' });
  assert.deepEqual(await database.lookup(8, capture, 'agent', '人物名\nあのね、ちょっと聞いて。'), { status: 'ambiguous' });
  assert.deepEqual(await database.lookup(8, text, 'luna', 'もう少しだけ待ってね。'), { status: 'ambiguous' });

  const differentScene = fixture(query => query === text ? [otherReply, reply] : [{ ...previous, scene: '2' }]);
  assert.deepEqual(await differentScene.lookup(8, capture, 'agent', lastBox), { status: 'ambiguous' });
  const truncatedPrevious = fixture(query => query === text ? [otherReply, reply] : Array(24).fill(previous));
  assert.deepEqual(await truncatedPrevious.lookup(8, capture, 'agent', lastBox), { status: 'ambiguous' });
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

test('Cold Steel III Agent searches for a heart when the capture contains its CP932 substitute', async () => {
  const dialogue = {
    ...row,
    jpnSearchText: 'これにしましょう～♥',
    jpnHtmlText: 'これにしましょう～♥',
    engSearchText: 'Let’s go with this one! ♥',
  };
  const queries = [];
  const database = fixture(query => {
    queries.push(query);
    return [dialogue];
  });
  assert.deepEqual(await database.lookup(8, '人物名\nこれにしましょう～㈱', 'agent'), {
    status: 'matched', speaker: 'Test speaker', english: dialogue.engSearchText,
  });
  assert.deepEqual(queries, ['これにしましょう～♥']);
  assert.deepEqual(await database.lookup(8, 'これにしましょう～㈱', 'luna'), { status: 'unmatched' });
  assert.deepEqual(await database.lookup(8, 'これにしましょう～(株)', 'agent'), { status: 'unmatched' });
});

test('Cold Steel III voice links preserve notes and stars when matching their dialogue', async () => {
  const dialogue = {
    ...row,
    jpnSearchText: 'そろそろ始めましょう♪',
    jpnHtmlText: '<a href="javascript:void(0)" class="dialogue-line" data-audio="talk/8/test.opus">そろそろ始めましょう♪</a>',
    engSearchText: 'Let’s get started! ♪',
  };
  const withStar = {
    ...dialogue,
    jpnSearchText: dialogue.jpnSearchText.replace('♪', '☆'),
    jpnHtmlText: dialogue.jpnHtmlText.replace('♪', '☆'),
    engSearchText: 'Time to begin! ☆',
  };
  const database = fixture([dialogue, withStar]);
  assert.deepEqual(await database.lookup(8, dialogue.jpnSearchText, 'agent'), {
    status: 'matched', speaker: 'Test speaker', english: dialogue.engSearchText,
  });
  assert.deepEqual(await database.lookup(8, withStar.jpnSearchText, 'luna'), {
    status: 'matched', speaker: 'Test speaker', english: withStar.engSearchText,
  });

  const unknownLink = { ...dialogue, jpnHtmlText: '<a href="/unknown">そろそろ始めましょう♪</a>' };
  assert.deepEqual(await fixture([unknownLink]).lookup(8, dialogue.jpnSearchText, 'agent'), { status: 'unmatched' });
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
