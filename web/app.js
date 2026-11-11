const messages = document.getElementById('messages');
const form = document.getElementById('composer');
const input = document.getElementById('input');
const send = document.getElementById('send');

function add(className, text = '') {
  const el = document.createElement('div');
  el.className = className;
  el.textContent = text;
  messages.append(el);
  messages.scrollTop = messages.scrollHeight;
  return el;
}

const seconds = (ms) => `${(ms / 1000).toFixed(2)} s`;

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
  add('msg user', message);
  const answer = add('msg assistant pending');
  const sentAt = performance.now();
  let firstTokenMs;
  let finished = false;

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    if (!response.ok) {
      const problem = await response.json().catch(() => ({}));
      throw new Error(problem.error || `The server answered ${response.status}.`);
    }
    await readEvents(response, (name, data) => {
      if (name === 'token') {
        firstTokenMs ??= performance.now() - sentAt;
        answer.textContent += data.text;
        messages.scrollTop = messages.scrollHeight;
      } else if (name === 'done') {
        finished = true;
        const first = firstTokenMs === undefined ? 'no text' : seconds(firstTokenMs);
        add('timing', `first token ${first} · total ${seconds(performance.now() - sentAt)}`);
      } else if (name === 'error') {
        throw new Error(data.message);
      }
    });
    if (!finished) throw new Error('The reply was cut off. Please try again.');
  } catch (err) {
    const text = err instanceof TypeError ? 'Could not reach the server.' : err.message;
    if (answer.textContent) add('msg assistant error', text);
    else {
      answer.textContent = text;
      answer.classList.add('error');
    }
  } finally {
    answer.classList.remove('pending');
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = input.value.trim();
  if (!message || send.disabled) return;
  input.value = '';
  input.style.height = 'auto';
  send.disabled = true;
  await ask(message);
  send.disabled = false;
  input.focus();
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

input.focus();
