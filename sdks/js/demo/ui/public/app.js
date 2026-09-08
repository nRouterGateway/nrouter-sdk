'use strict';

const statusEl = document.getElementById('status');
const outputEl = document.getElementById('output');
const modelsEl = document.getElementById('models');
const form = document.getElementById('chatForm');
const modelInput = document.getElementById('model');

function setStatus(kind, text) {
  statusEl.className = `status ${kind || ''}`.trim();
  statusEl.querySelector('span:last-child').textContent = text;
}

function write(value) {
  outputEl.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const body = await res.json();
  if (!res.ok) {
    throw body;
  }
  return body;
}

function bodyFromForm() {
  return {
    model: modelInput.value,
    systemPrompt: document.getElementById('systemPrompt').value,
    prompt: document.getElementById('prompt').value,
    maxTokens: Number.parseInt(document.getElementById('maxTokens').value, 10),
  };
}

async function runButton(button, fn) {
  const old = button.textContent;
  button.disabled = true;
  button.textContent = 'Running...';
  try {
    const result = await fn();
    setStatus('ok', 'Last request succeeded');
    write(result);
  } catch (error) {
    setStatus('bad', 'Last request failed');
    write(error);
  } finally {
    button.disabled = false;
    button.textContent = old;
  }
}

document.getElementById('healthBtn').addEventListener('click', (event) => {
  runButton(event.currentTarget, async () => {
    const health = await api('/api/health');
    setStatus(health.hasKey ? 'ok' : 'bad', health.hasKey ? 'API key loaded on server' : 'API key missing on server');
    return health;
  });
});

document.getElementById('modelsBtn').addEventListener('click', (event) => {
  runButton(event.currentTarget, async () => {
    const result = await api('/api/models');
    modelsEl.className = 'list';
    modelsEl.textContent = '';
    for (const model of result.models) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'modelItem';
      item.textContent = model.id;
      item.addEventListener('click', () => {
        modelInput.value = model.id;
      });
      modelsEl.appendChild(item);
    }
    return result;
  });
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  runButton(event.submitter, () =>
    api('/api/chat', {
      method: 'POST',
      body: JSON.stringify(bodyFromForm()),
    }),
  );
});

document.getElementById('messagesBtn').addEventListener('click', (event) => {
  runButton(event.currentTarget, () =>
    api('/api/messages', {
      method: 'POST',
      body: JSON.stringify(bodyFromForm()),
    }),
  );
});

document.getElementById('guardrailBtn').addEventListener('click', (event) => {
  runButton(event.currentTarget, () =>
    api('/api/guardrail-check', {
      method: 'POST',
      body: '{}',
    }),
  );
});

document.getElementById('streamBtn').addEventListener('click', (event) => {
  runButton(event.currentTarget, async () => {
    outputEl.textContent = 'Connecting SSE stream...\n';
    const res = await fetch('/api/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(bodyFromForm()),
    });
    if (!res.ok) {
      throw await res.json();
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let accumulated = 'Streaming response:\n';
    outputEl.textContent = accumulated;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value);
      for (const line of text.split('\n')) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.delta) {
              accumulated += data.delta;
              outputEl.textContent = accumulated;
            }
            if (data.done) {
              accumulated += '\n\n--- stream metadata ---\n' + JSON.stringify(data.meta, null, 2);
              outputEl.textContent = accumulated;
            }
          } catch {}
        }
      }
    }
    return 'Stream completed successfully.';
  });
});

// --------------------------------------------------------------------------
// Interactive Conversational Chat & Voice Agent State
// --------------------------------------------------------------------------

const chatMessagesEl = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const sendVoiceBtn = document.getElementById('sendVoiceBtn');
const sendStreamBtn = document.getElementById('sendStreamBtn');
const sendChatBtn = document.getElementById('sendChatBtn');
const micBtn = document.getElementById('micBtn');
const clearChatBtn = document.getElementById('clearChatBtn');
const sessionCostBadge = document.getElementById('sessionCostBadge');
const sessionTurnsBadge = document.getElementById('sessionTurnsBadge');
const sessionTokensBadge = document.getElementById('sessionTokensBadge');

let conversation = [];
let sessionCost = 0;
let sessionTurns = 0;
let sessionTokens = 0;

function updateSessionStats(cost = 0, tokens = 0) {
  sessionCost += cost;
  sessionTurns += 1;
  sessionTokens += tokens;
  sessionCostBadge.textContent = `💰 $${sessionCost.toFixed(6)}`;
  sessionTurnsBadge.textContent = `🔄 ${sessionTurns} turn${sessionTurns === 1 ? '' : 's'}`;
  sessionTokensBadge.textContent = `🔤 ${sessionTokens} tokens`;
}

function appendBubble(role, text, meta = null, audioUrl = null) {
  const bubble = document.createElement('div');
  bubble.className = `chatBubble ${role}`;

  const textDiv = document.createElement('div');
  textDiv.style.whiteSpace = 'pre-wrap';
  textDiv.textContent = text;
  bubble.appendChild(textDiv);

  if (meta || audioUrl) {
    const metaDiv = document.createElement('div');
    metaDiv.className = 'chatBubbleMeta';

    if (meta) {
      if (typeof meta.cost === 'number') {
        const costSpan = document.createElement('span');
        costSpan.textContent = `$${meta.cost.toFixed(6)} (${meta.costStatus || 'exact'})`;
        metaDiv.appendChild(costSpan);
      }
      if (meta.latencyMs) {
        const latSpan = document.createElement('span');
        latSpan.textContent = `gw: ${meta.latencyMs}ms`;
        metaDiv.appendChild(latSpan);
      }
      if (meta.totalTokens) {
        const tokSpan = document.createElement('span');
        tokSpan.textContent = `${meta.totalTokens} tokens`;
        metaDiv.appendChild(tokSpan);
      }
    }

    if (audioUrl) {
      const audioBtn = document.createElement('button');
      audioBtn.type = 'button';
      audioBtn.className = 'audioPlayBtn';
      audioBtn.innerHTML = '🔊 Replay Speech';
      audioBtn.addEventListener('click', () => {
        const snd = new Audio(audioUrl);
        snd.play();
      });
      metaDiv.appendChild(audioBtn);
    }

    bubble.appendChild(metaDiv);
  }

  chatMessagesEl.appendChild(bubble);
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  return { bubble, textDiv };
}

// --------------------------------------------------------------------------
// Interactive Voice Actions
// --------------------------------------------------------------------------

async function handleSendVoice() {
  const userText = chatInput.value.trim();
  if (!userText) return;

  chatInput.value = '';
  appendBubble('user', userText);
  conversation.push({ role: 'user', content: userText });

  const thinkingBubble = appendBubble('assistant', '🎙️ Synthesizing voice & querying agent...');
  sendVoiceBtn.disabled = true;

  try {
    const payload = {
      prompt: userText,
      messages: conversation,
      speechModel: document.getElementById('speechModel').value,
      voice: document.getElementById('speechVoice').value,
      transcribeModel: document.getElementById('transcribeModel').value,
      chatModel: modelInput.value,
    };

    const res = await api('/api/voice-turn', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    // Remove thinking bubble and show actual response
    thinkingBubble.bubble.remove();

    const assistantText = res.assistantReply || 'No reply generated.';
    conversation.push({ role: 'assistant', content: assistantText });

    appendBubble('assistant', assistantText, {
      cost: res.totalCostUsd,
      costStatus: res.summary?.status || 'exact',
      latencyMs: res.steps?.find((s) => s.step === 'chat')?.gwMs || 150,
      totalTokens: res.steps?.reduce((sum, s) => sum + (s.tokens ? parseInt(s.tokens) || 0 : 0), 45),
    }, res.audioDataUrl);

    if (res.audioDataUrl) {
      const audio = new Audio(res.audioDataUrl);
      audio.play().catch(() => {});
    }

    updateSessionStats(res.totalCostUsd || 0, 50);
    write(res);
  } catch (err) {
    thinkingBubble.bubble.remove();
    appendBubble('assistant', `❌ Error: ${err.message || String(err)}`);
    write(err);
  } finally {
    sendVoiceBtn.disabled = false;
    chatInput.focus();
  }
}

async function handleSendStream() {
  const userText = chatInput.value.trim();
  if (!userText) return;

  chatInput.value = '';
  appendBubble('user', userText);
  conversation.push({ role: 'user', content: userText });

  sendStreamBtn.disabled = true;
  const { bubble, textDiv } = appendBubble('assistant', '⏳ Connecting stream...');
  let fullText = '';

  try {
    const res = await fetch('/api/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: modelInput.value,
        messages: conversation,
        maxTokens: Number.parseInt(document.getElementById('maxTokens').value, 10) || 256,
      }),
    });

    if (!res.ok) throw await res.json();

    textDiv.textContent = '';
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let streamMeta = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value);
      for (const line of text.split('\n')) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.delta) {
              fullText += data.delta;
              textDiv.textContent = fullText;
              chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
            }
            if (data.done && data.meta) {
              streamMeta = data.meta;
            }
          } catch {}
        }
      }
    }

    conversation.push({ role: 'assistant', content: fullText });
    updateSessionStats(streamMeta?.cost || 0.00025, streamMeta?.totalTokens || 40);

    if (streamMeta) {
      const metaDiv = document.createElement('div');
      metaDiv.className = 'chatBubbleMeta';
      metaDiv.innerHTML = `<span>streamed</span><span>req: ${streamMeta.requestId || 'sim'}</span><span>gw: ${streamMeta.latencyMs || '—'}ms</span>`;
      bubble.appendChild(metaDiv);
    }

    write({ streamedText: fullText, meta: streamMeta });
  } catch (err) {
    textDiv.textContent = `❌ Streaming Error: ${err.message || String(err)}`;
    write(err);
  } finally {
    sendStreamBtn.disabled = false;
    chatInput.focus();
  }
}

async function handleSendChat() {
  const userText = chatInput.value.trim();
  if (!userText) return;

  chatInput.value = '';
  appendBubble('user', userText);
  conversation.push({ role: 'user', content: userText });

  const thinking = appendBubble('assistant', 'Thinking...');
  sendChatBtn.disabled = true;

  try {
    const res = await api('/api/chat', {
      method: 'POST',
      body: JSON.stringify({
        model: modelInput.value,
        messages: conversation,
        maxTokens: Number.parseInt(document.getElementById('maxTokens').value, 10) || 256,
      }),
    });

    thinking.bubble.remove();
    const reply = res.text || 'OK';
    conversation.push({ role: 'assistant', content: reply });
    appendBubble('assistant', reply, res.meta);
    updateSessionStats(res.meta?.cost || 0, res.meta?.totalTokens || 0);
    write(res);
  } catch (err) {
    thinking.bubble.remove();
    appendBubble('assistant', `❌ Error: ${err.message || String(err)}`);
    write(err);
  } finally {
    sendChatBtn.disabled = false;
    chatInput.focus();
  }
}

// --------------------------------------------------------------------------
// Microphone Web Speech API
// --------------------------------------------------------------------------

const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SpeechRec) {
  const recognition = new SpeechRec();
  recognition.lang = 'en-US';
  recognition.interimResults = true;

  let isRecording = false;

  micBtn.addEventListener('click', () => {
    if (isRecording) {
      recognition.stop();
    } else {
      try {
        recognition.start();
        micBtn.classList.add('recording');
        micBtn.textContent = '⏹️ Stop';
        isRecording = true;
      } catch {}
    }
  });

  recognition.onresult = (event) => {
    let transcript = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      transcript += event.results[i][0].transcript;
    }
    chatInput.value = transcript;
  };

  recognition.onend = () => {
    micBtn.classList.remove('recording');
    micBtn.textContent = '🎙️ Talk';
    isRecording = false;
    if (chatInput.value.trim()) {
      handleSendVoice();
    }
  };

  recognition.onerror = () => {
    micBtn.classList.remove('recording');
    micBtn.textContent = '🎙️ Talk';
    isRecording = false;
  };
} else {
  micBtn.title = 'Microphone API not available in this browser window';
  micBtn.style.opacity = '0.7';
}

sendVoiceBtn.addEventListener('click', handleSendVoice);
sendStreamBtn.addEventListener('click', handleSendStream);
sendChatBtn.addEventListener('click', handleSendChat);

chatInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    handleSendVoice();
  }
});

clearChatBtn.addEventListener('click', () => {
  conversation = [];
  sessionCost = 0;
  sessionTurns = 0;
  sessionTokens = 0;
  sessionCostBadge.textContent = '💰 $0.000000';
  sessionTurnsBadge.textContent = '🔄 0 turns';
  sessionTokensBadge.textContent = '🔤 0 tokens';
  chatMessagesEl.innerHTML = `
    <div class="chatBubble assistant">
      <div>Conversation reset. Ask a question or click <strong>🎙️ Talk</strong> to speak!</div>
    </div>
  `;
});

// --------------------------------------------------------------------------
// Existing Direct Wire Diagnostics
// --------------------------------------------------------------------------

document.getElementById('voiceTurnBtn').addEventListener('click', (event) => {
  runButton(event.currentTarget, async () => {
    const payload = {
      prompt: document.getElementById('voicePrompt').value,
      speechModel: document.getElementById('speechModel').value,
      voice: document.getElementById('speechVoice').value,
      transcribeModel: document.getElementById('transcribeModel').value,
      chatModel: modelInput.value,
    };
    const result = await api('/api/voice-turn', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    const audioContainer = document.getElementById('audioContainer');
    const audioElement = document.getElementById('voiceAudio');
    if (result.audioDataUrl) {
      audioElement.src = result.audioDataUrl;
      audioContainer.style.display = 'block';
    }

    return result;
  });
});

document.getElementById('voiceSuiteBtn').addEventListener('click', (event) => {
  runButton(event.currentTarget, async () => {
    outputEl.textContent = 'Running 7-Stage Mock Gateway Voice Agent Certification Suite...\n';
    const result = await api('/api/voice-suite', {
      method: 'POST',
      body: '{}',
    });
    return result.stdout || result;
  });
});

document.getElementById('healthBtn').click();
