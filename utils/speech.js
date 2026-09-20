import * as Speech from 'expo-speech';

const IMPORTANT_HAZARDS = new Set([
  'person',
  'car',
  'chair',
  'stop sign',
]);

const MIN_CONFIDENCE = 0.6;
const MIN_PERSON_CONFIDENCE = 0.5;
const MIN_TRAFFIC_LIGHT_CONFIDENCE = 0.4;
const MIN_STOP_SIGN_CONFIDENCE = 0;

export function getImportantHazardDetections(detections = []) {
  return detections
    .filter((detection) => {
      const label = String(detection.label).toLowerCase().trim().replace(/\s+/g, ' ');
      const minimumConfidence =
        label === 'person'
          ? MIN_PERSON_CONFIDENCE
          : label === 'traffic light'
          ? MIN_TRAFFIC_LIGHT_CONFIDENCE
          : label === 'stop sign'
            ? MIN_STOP_SIGN_CONFIDENCE
            : MIN_CONFIDENCE;
      const confidenceIsAcceptable =
        label === 'stop sign' || Number(detection.confidence) >= minimumConfidence;
      return IMPORTANT_HAZARDS.has(label) && confidenceIsAcceptable;
    })
    .sort((a, b) => {
      const aDistance = Number(a.distance_m_estimate);
      const bDistance = Number(b.distance_m_estimate);
      if (aDistance > 0 && bDistance > 0) return aDistance - bDistance;
      if (aDistance > 0) return -1;
      if (bDistance > 0) return 1;
      return Number(b.confidence) - Number(a.confidence);
    });
}

export function getImportantHazards(detections = []) {
  return getImportantHazardDetections(detections)
    .map((detection) => String(detection.label).toLowerCase().trim().replace(/\s+/g, ' '))
    .filter((label, index, labels) => labels.indexOf(label) === index);
}

export function formatDetectionWithDistance(detection) {
  const label = String(detection.label).toLowerCase().trim().replace(/\s+/g, ' ');
  const distance = Number(detection.distance_m_estimate);
  return Number.isFinite(distance) && distance > 0
    ? `${label}, about ${distance.toFixed(1)} meters away`
    : label;
}

export function getPersonDistance(detections = []) {
  const person = getImportantHazardDetections(detections).find(
    (detection) => String(detection.label).toLowerCase().trim() === 'person'
  );
  const distance = Number(person?.distance_m_estimate);
  return Number.isFinite(distance) && distance > 0 ? distance : null;
}

export function buildVerificationSpeech({ result, detections = [] }) {
  const matched = Boolean(result?.matched);
  // Known match: person is announced by name. Otherwise treat person as an obstacle.
  const hazards = getImportantHazardDetections(detections)
    .filter(
      (detection) =>
        !matched ||
        String(detection.label).toLowerCase().trim() !== 'person'
    )
    .slice(0, 4);
  const personDistance = getPersonDistance(detections);
  const parts = [];

  if (matched && result.name) {
    const relationship = result.relationship ? `, your ${result.relationship}` : '';
    const distance = personDistance ? `, about ${personDistance.toFixed(1)} meters away` : '';
    parts.push(`${result.name}${relationship}${distance}.`);
  }
  if (hazards.length > 0) {
    parts.push(`Obstacles: ${hazards.map(formatDetectionWithDistance).join('; ')}.`);
  }

  return parts.join(' ');
}

const speechQueue = [];
let speaking = false;
let activeResolve = null;
let lastSpokenText = '';

function drainSpeechQueue() {
  if (speaking || speechQueue.length === 0) return;
  const next = speechQueue.shift();
  speaking = true;
  activeResolve = next.resolve;
  lastSpokenText = next.message;
  const finish = () => {
    const resolve = activeResolve;
    activeResolve = null;
    speaking = false;
    resolve?.();
    drainSpeechQueue();
  };
  Speech.speak(next.message, {
    rate: 0.9,
    pitch: 1.0,
    onDone: finish,
    onStopped: finish,
    onError: (error) => {
      console.warn('Speech error', error);
      finish();
    },
  });
}

export async function stopSpeaking({ clearQueue = true } = {}) {
  if (clearQueue) {
    const queued = speechQueue.splice(0);
    queued.forEach((item) => item.resolve());
  }
  await Speech.stop();
}

export function getLastSpokenText() {
  return lastSpokenText;
}

export function speakText(message, { priority = 'normal' } = {}) {
  const text = String(message || '').trim();
  if (!text) return Promise.resolve();

  return new Promise(async (resolve) => {
    if (priority === 'assistant') {
      const queued = speechQueue.splice(0);
      queued.forEach((item) => item.resolve());
      if (speaking) await Speech.stop();
      speechQueue.unshift({ message: text, resolve });
    } else {
      speechQueue.push({ message: text, resolve });
    }
    drainSpeechQueue();
  });
}

export async function speakVerificationResult({ result, detections = [] }) {
  const spoken = String(result?.spoken_text || '').trim();
  const message = spoken || buildVerificationSpeech({ result, detections });
  if (!message) return;
  await speakText(message);
}
