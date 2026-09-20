import { ASSISTANT_SERVER_URL } from './config';

const REQUEST_TIMEOUT_MS = 30000;

async function fetchWithTimeout(path, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${ASSISTANT_SERVER_URL}${path}`, {
      ...options,
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.detail || payload.error || `Assistant request failed (${response.status})`);
    }
    return payload;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('The voice assistant timed out.');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function transcribeAssistantAudio(uri) {
  if (!uri) throw new Error('No recording was created.');
  const audioResponse = await fetch(uri);
  if (!audioResponse.ok) {
    throw new Error('The recording could not be read.');
  }
  const audioBlob = await audioResponse.blob();
  const form = new FormData();
  form.append('file', audioBlob, `voice-${Date.now()}.m4a`);
  const result = await fetchWithTimeout(
    '/assistant/transcribe',
    { method: 'POST', body: form },
    45000
  );
  return String(result.text || '').trim();
}

export async function sendAssistantTurn({
  conversationId,
  text = '',
  appContext = {},
  toolOutputs = [],
}) {
  return fetchWithTimeout('/assistant/turn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversation_id: conversationId,
      input: text,
      app_context: appContext,
      tool_outputs: toolOutputs,
    }),
  });
}

export async function checkAssistantHealth() {
  return fetchWithTimeout('/health', {}, 4000);
}
