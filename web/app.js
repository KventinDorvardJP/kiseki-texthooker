import { captureUrl, decodeCapture, sources } from './capture.js';

const element = id => document.getElementById(id);
const form = element('connection-form');
const source = element('source');
const url = element('websocket-url');
const button = element('connection-button');
const connectionState = element('connection-state');
const connectionMessage = element('connection-message');
const game = element('game');
const gameMessage = element('game-message');
const retryCatalog = element('retry-catalog');
const scroll = element('log-scroll');
const empty = element('empty');
const emptyMessage = element('empty-message');
const entries = element('entries');
const clear = element('clear');
const logLimit = 20;

const addresses = { ...sources };
let currentSource = source.value;
let socket;
let connectTimer;
let activeLookup;
const lookupQueue = [];

function setConnection(state, label, message = '') {
  connectionState.dataset.state = state;
  connectionState.textContent = label;
  connectionMessage.textContent = message;
  connectionMessage.hidden = !message;
  const active = state === 'connected' || state === 'connecting';
  button.textContent = active ? 'Disconnect' : 'Connect';
  url.disabled = source.disabled = active;
  emptyMessage.textContent = state === 'connected'
    ? 'Captured lines will appear here as you play.'
    : 'Connect to Agent or LunaTranslator to start capturing lines.';
}

function disconnect(state, label, message) {
  clearTimeout(connectTimer);
  const previous = socket;
  socket = undefined;
  previous?.close();
  setConnection(state, label, message);
}

source.addEventListener('change', () => {
  addresses[currentSource] = url.value;
  currentSource = source.value;
  url.value = addresses[currentSource];
  setConnection('idle', 'Disconnected');
});

form.addEventListener('submit', event => {
  event.preventDefault();
  if (socket) {
    disconnect('idle', 'Disconnected');
    return;
  }

  const kind = source.value;
  let connection;
  try {
    connection = new WebSocket(captureUrl(kind, url.value));
  } catch (error) {
    setConnection('error', 'Connection failed', error.message);
    return;
  }

  socket = connection;
  setConnection('connecting', 'Connecting…');
  connectTimer = setTimeout(() => {
    if (socket === connection) disconnect('error', 'Connection timed out', 'Check the source and address, then reconnect.');
  }, 5000);

  connection.addEventListener('open', () => {
    if (socket !== connection) return;
    clearTimeout(connectTimer);
    setConnection('connected', `Connected to ${kind === 'luna' ? 'LunaTranslator' : 'Agent'}`);
  });
  connection.addEventListener('message', event => {
    if (socket !== connection) return;
    const text = decodeCapture(kind, event.data);
    if (text !== null) prependEntry(text);
  });
  connection.addEventListener('close', () => {
    if (socket !== connection) return;
    const connected = connectionState.dataset.state === 'connected';
    disconnect('error', connected ? 'Connection closed' : 'Connection failed',
      connected ? 'Reconnect to resume capture.' : 'Start the source’s WebSocket service and check its address.');
  });
});

async function loadCatalog() {
  retryCatalog.hidden = true;
  game.disabled = true;
  game.replaceChildren(new Option('Loading catalog…', ''));
  gameMessage.textContent = 'Used to look up English in Trails in the Database.';
  try {
    const response = await fetch('/api/games');
    if (!response.ok) throw new Error();
    const games = await response.json();
    game.replaceChildren(new Option('Choose a game', ''), ...games.map(({ id, title }) => new Option(title, id)));
    game.disabled = false;
  } catch {
    game.replaceChildren(new Option('Catalog unavailable', ''));
    gameMessage.textContent = 'You can still capture and mine Japanese.';
    retryCatalog.hidden = false;
  }
}

function isFollowingLog() {
  const selection = window.getSelection();
  return scroll.scrollTop < 24
    && !(selection && !selection.isCollapsed && scroll.contains(selection.anchorNode));
}

function prependEntry(text) {
  const following = isFollowingLog();
  const entry = document.createElement('li');
  entry.className = 'entry';
  const japanese = document.createElement('p');
  japanese.className = 'dialogue japanese';
  japanese.lang = 'ja';
  japanese.textContent = text;
  const status = document.createElement('p');
  status.className = 'entry-status';
  entry.append(japanese, status);
  empty.hidden = true;
  entries.prepend(entry);
  if (entries.childElementCount > logLimit) {
    const oldest = entries.lastElementChild;
    const pendingIndex = lookupQueue.findIndex(job => oldest.contains(job.status));
    if (pendingIndex !== -1) lookupQueue.splice(pendingIndex, 1);
    oldest.remove();
  }
  clear.disabled = false;
  if (following) scroll.scrollTop = 0;

  if (!game.value) status.textContent = 'Choose a game to look up English for new lines.';
  else if (text.length > 1000) status.textContent = 'Line too long for lookup.';
  else {
    status.textContent = 'Looking up English…';
    lookupQueue.push({ gameId: Number(game.value), text, status });
    runLookupQueue();
  }
}

async function runLookupQueue() {
  if (activeLookup || !lookupQueue.length) return;
  const { gameId, text, status } = lookupQueue.shift();
  const controller = new AbortController();
  activeLookup = controller;
  try {
    const response = await fetch('/api/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameId, text }),
      signal: controller.signal,
    });
    if (response.status === 429) {
      status.textContent = 'Lookup service busy.';
      return;
    }
    if (!response.ok) throw new Error();
    const result = await response.json();
    if (!status.isConnected) return;
    if (result.status === 'matched' && typeof result.english === 'string') {
      const following = isFollowingLog();
      const english = document.createElement('p');
      english.className = 'dialogue english';
      english.lang = 'en';
      if (typeof result.speaker === 'string' && result.speaker) {
        const speaker = document.createElement('strong');
        speaker.textContent = `${result.speaker}: `;
        english.append(speaker);
      }
      english.append(result.english);
      status.replaceWith(english);
      if (following) scroll.scrollTop = 0;
    } else {
      const messages = {
        ambiguous: 'No unique match.',
        partial: 'Found in a longer dialogue entry.',
      };
      status.textContent = messages[result.status] ?? 'No matching localization.';
    }
  } catch {
    if (status.isConnected) status.textContent = 'Lookup unavailable.';
  } finally {
    activeLookup = undefined;
    runLookupQueue();
  }
}

clear.addEventListener('click', () => {
  lookupQueue.length = 0;
  activeLookup?.abort();
  entries.replaceChildren();
  empty.hidden = false;
  clear.disabled = true;
});
retryCatalog.addEventListener('click', loadCatalog);
loadCatalog();
