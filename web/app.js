const $ = (id) => document.getElementById(id);
const messages = $('messages');
const form = $('composer');
const input = $('input');
const send = $('send');
const sessionList = $('sessions');

const NAME_KEY = 'minimi.name';
let user = null; // {user_id, user_name}
let sessionId = null; // null until the first reply of a new chat is stored
let view = 0; // changes whenever another chat is shown
let asking = 0; // the latest question; older streams must not touch the Send button

// The browser only remembers the name; everything else lives on the server.
const savedName = () => {
  try {
    return localStorage.getItem(NAME_KEY);
  } catch {
    return null;
  }
};
const saveName = (name) => {
  try {
    if (name) localStorage.setItem(NAME_KEY, name);
    else localStorage.removeItem(NAME_KEY);
  } catch {
    /* private window: the name is asked again next time */
  }
};

async function api(path, options) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `The server answered ${response.status}.`);
  return data;
}

const postJson = (body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

function add(className, text = '') {
  const el = document.createElement('div');
  el.className = className;
  el.textContent = text;
  messages.append(el);
  messages.scrollTop = messages.scrollHeight;
  return el;
}

const seconds = (ms) => `${(ms / 1000).toFixed(2)} s`;

// --- showing an answer ---

const CITATION = /\[(\d+(?:\s*,\s*\d+)*)\]/g;

// Turns the model's Markdown into safe HTML, then turns [n] into links to source n.
function renderAnswer(el, text, sources) {
  if (!window.marked || !window.DOMPurify) {
    el.textContent = text;
    return new Set();
  }
  el.innerHTML = DOMPurify.sanitize(marked.parse(text, { gfm: true }));
  for (const table of el.querySelectorAll('table')) {
    const scroll = document.createElement('div');
    scroll.className = 'table-scroll';
    table.replaceWith(scroll);
    scroll.append(table);
  }
  const byNumber = new Map(sources.map((s) => [s.n, s]));
  const cited = new Set();
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) {
    if (!walker.currentNode.parentElement.closest('a, code, pre')) textNodes.push(walker.currentNode);
  }
  for (const node of textNodes) {
    if (!node.nodeValue.includes('[')) continue;
    const pieces = [];
    let last = 0;
    for (const match of node.nodeValue.matchAll(CITATION)) {
      const numbers = match[1].split(',').map((n) => Number(n.trim()));
      if (!numbers.every((n) => byNumber.has(n))) continue;
      pieces.push(node.nodeValue.slice(last, match.index));
      for (const n of numbers) {
        const source = byNumber.get(n);
        const link = document.createElement('a');
        link.className = 'cite';
        link.href = source.url;
        link.title = source.title;
        link.textContent = String(n);
        pieces.push(link);
        cited.add(n);
      }
      last = match.index + match[0].length;
    }
    if (pieces.length === 0) continue;
    pieces.push(node.nodeValue.slice(last));
    node.replaceWith(...pieces);
  }
  for (const link of el.querySelectorAll('a')) {
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  }
  return cited;
}

const host = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

// The numbered list under an answer: only the sources it actually cites.
function showSources(after, sources, cited) {
  const used = sources.filter((s) => cited.has(s.n));
  if (used.length === 0) return;
  const list = document.createElement('ol');
  list.className = 'sources';
  for (const source of used) {
    const item = document.createElement('li');
    item.value = source.n;
    const link = document.createElement('a');
    link.href = source.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = source.title || host(source.url);
    const where = document.createElement('span');
    where.textContent = ` ${host(source.url)}`;
    item.append(link, where);
    list.append(item);
  }
  after.after(list);
}

// --- name ---

function askName(problem = '') {
  user = null;
  $('name-error').textContent = problem;
  $('name-screen').hidden = false;
  $('name-input').focus();
}

async function signIn(name) {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  user = await api('/api/users', postJson({ name, timezone }));
  saveName(name);
  $('who-name').textContent = name;
  $('name-screen').hidden = true;
  newChat();
  await loadSessions();
}

$('name-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = $('name-input').value.trim();
  if (!name) return;
  try {
    await signIn(name);
  } catch (err) {
    askName(err instanceof TypeError ? 'Could not reach the server.' : err.message);
  }
});

$('switch-user').addEventListener('click', () => {
  saveName(null);
  $('name-input').value = '';
  askName();
});

// --- chats ---

async function loadSessions() {
  if (!user) return;
  const { sessions } = await api(`/api/sessions?user_id=${encodeURIComponent(user.user_id)}`);
  sessionList.replaceChildren();
  if (sessions.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No chats yet.';
    sessionList.append(empty);
  }
  for (const session of sessions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = session.title || 'New chat';
    button.title = button.textContent;
    if (session.session_id === sessionId) button.setAttribute('aria-current', 'true');
    button.addEventListener('click', () => openSession(session.session_id));
    sessionList.append(button);
  }
}

function newChat() {
  view += 1;
  sessionId = null;
  messages.replaceChildren();
  document.body.classList.remove('sidebar-open');
  for (const b of sessionList.querySelectorAll('[aria-current]')) b.removeAttribute('aria-current');
  input.focus();
}

async function openSession(id) {
  const mine = (view += 1);
  document.body.classList.remove('sidebar-open');
  const path = `/api/sessions/${encodeURIComponent(id)}/turns?user_id=${encodeURIComponent(user.user_id)}`;
  const { turns } = await api(path);
  if (mine !== view) return; // another chat was opened meanwhile
  sessionId = id;
  messages.replaceChildren();
  for (const turn of turns) {
    add('msg user', turn.user_message);
    const answer = add('msg assistant');
    showSources(answer, turn.sources, renderAnswer(answer, turn.assistant_message, turn.sources));
  }
  await loadSessions();
  input.focus();
}

$('new-chat').addEventListener('click', newChat);
$('toggle-sidebar').addEventListener('click', () => document.body.classList.toggle('sidebar-open'));
$('chat').addEventListener('click', (event) => {
  if (!event.target.closest('#toggle-sidebar')) document.body.classList.remove('sidebar-open');
});

// --- asking ---

// Reads a server-sent event stream and calls onEvent(name, data) for each event.
async function readEvents(response, onEvent) {
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value.replace(/\r\n/g, '\n');
    let end;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let name = 'message';
      const data = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) name = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (data.length) onEvent(name, JSON.parse(data.join('\n')));
    }
  }
}

async function ask(message) {
  const mine = (asking += 1);
  const shown = view;
  const release = () => {
    if (mine === asking) send.disabled = false;
  };
  send.disabled = true;
  add('msg user', message);
  const status = add('status');
  status.hidden = true;
  const answer = add('msg assistant pending');
  const sentAt = performance.now();
  const sources = [];
  const queries = []; // {text, state: 'running' | 'done' | 'failed'}
  let text = '';
  let cited = new Set();
  let firstTokenMs;
  let finished = false;
  let drawing = false;

  const draw = () => {
    drawing = false;
    cited = renderAnswer(answer, text, sources);
    if (shown === view) messages.scrollTop = messages.scrollHeight;
  };
  const showStatus = () => {
    const running = queries.some((q) => q.state === 'running');
    status.hidden = false;
    status.replaceChildren(running ? 'Searching the web: ' : 'Searched the web: ');
    queries.forEach((q, i) => {
      const item = document.createElement('span');
      item.textContent = q.state === 'failed' ? `${q.text} (failed)` : q.text;
      if (q.state === 'failed') item.className = 'error';
      status.append(i ? ' · ' : '', item);
    });
    if (shown === view) messages.scrollTop = messages.scrollHeight;
  };

  try {
    const response = await fetch(
      '/api/chat',
      postJson({ user_id: user.user_id, session_id: sessionId, message }),
    );
    if (!response.ok) {
      const problem = await response.json().catch(() => ({}));
      throw new Error(problem.error || `The server answered ${response.status}.`);
    }
    await readEvents(response, (name, data) => {
      if (name === 'token') {
        firstTokenMs ??= performance.now() - sentAt;
        text += data.text;
        if (!drawing) {
          drawing = true;
          requestAnimationFrame(draw);
        }
      } else if (name === 'search') {
        for (const q of data.queries) queries.push({ text: q, state: 'running' });
        showStatus();
      } else if (name === 'sources') {
        sources.push(...data.sources);
        for (const q of queries) {
          if (q.state === 'running') q.state = data.failed.includes(q.text) ? 'failed' : 'done';
        }
        showStatus();
      } else if (name === 'done') {
        finished = true;
        answer.classList.remove('pending');
        draw();
        showSources(answer, sources, cited);
        const first = firstTokenMs === undefined ? 'no text' : seconds(firstTokenMs);
        const timing = `first token ${first} · total ${seconds(performance.now() - sentAt)}`;
        if (shown === view) {
          add('timing', timing);
          sessionId = data.session_id;
        }
        release(); // the title may still be on its way; do not make the user wait for it
        loadSessions().catch(() => {});
      } else if (name === 'title') {
        loadSessions().catch(() => {});
      } else if (name === 'error') {
        throw new Error(data.message);
      }
    });
    if (!finished) throw new Error('The reply was cut off. Please try again.');
  } catch (err) {
    const problem = err instanceof TypeError ? 'Could not reach the server.' : err.message;
    if (text) {
      draw();
      if (shown === view) add('msg assistant error', problem);
    } else {
      answer.textContent = problem;
      answer.classList.add('error');
    }
  } finally {
    answer.classList.remove('pending');
    release();
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const message = input.value.trim();
  if (!message || send.disabled || !user) return;
  input.value = '';
  input.style.height = 'auto';
  input.focus();
  ask(message);
});

input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    form.requestSubmit();
  }
});

input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = `${input.scrollHeight}px`;
});

// --- start ---

const remembered = savedName();
if (remembered) {
  signIn(remembered).catch((err) =>
    askName(err instanceof TypeError ? 'Could not reach the server.' : err.message),
  );
} else {
  askName();
}
