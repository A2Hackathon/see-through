import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Speech from 'expo-speech';
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
} from 'expo-audio';
import { sendAssistantTurn, transcribeAssistantAudio } from '../utils/assistantClient';
import { speakText, stopSpeaking } from '../utils/speech';

const YES_WORDS = new Set(['yes', 'yes please', 'confirm', 'do it', 'correct']);
const NO_WORDS = new Set(['no', 'cancel', 'never mind', 'do not']);

function newConversationId() {
  return `voice_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function cleanTranscript(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function confirmationAnswer(text) {
  const normalized = cleanTranscript(text).toLocaleLowerCase().replace(/[.!?]/g, '');
  if (YES_WORDS.has(normalized)) return true;
  if (NO_WORDS.has(normalized)) return false;
  return null;
}

function extractToolCalls(response) {
  const calls = response?.tool_calls || response?.toolCalls || [];
  return calls.map((call) => ({
    callId: call.call_id || call.callId || call.id,
    name: call.name || call.function?.name,
    args:
      typeof (call.arguments ?? call.function?.arguments) === 'string'
        ? JSON.parse((call.arguments ?? call.function?.arguments) || '{}')
        : call.arguments || call.function?.arguments || {},
  }));
}

export function useVoiceAssistant({ registry, onResponse }) {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [status, setStatus] = useState('idle');
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState('');
  const conversationId = useRef(newConversationId());
  const pendingConfirmation = useRef(null);
  const busyRef = useRef(false);

  useEffect(() => {
    setAudioModeAsync({
      allowsRecording: true,
      playsInSilentMode: true,
      shouldPlayInBackground: false,
    }).catch((audioError) => console.warn('Assistant audio mode skipped', audioError));
    return () => {
      Speech.stop();
    };
  }, []);

  const speakReply = useCallback(
    async (message) => {
      const text = cleanTranscript(message);
      if (!text) {
        setStatus('idle');
        return;
      }
      setStatus('speaking');
      onResponse?.(text);
      await speakText(text, { priority: 'assistant' });
      setStatus('idle');
    },
    [onResponse]
  );

  const continueToolTurn = useCallback(
    async (toolOutputs) => {
      const appContext = await registry.getContext();
      return sendAssistantTurn({
        conversationId: conversationId.current,
        appContext,
        toolOutputs,
      });
    },
    [registry]
  );

  const handleAssistantResponse = useCallback(
    async (initialResponse) => {
      let response = initialResponse;
      for (let turn = 0; turn < 5; turn += 1) {
        const toolCalls = extractToolCalls(response);
        if (!toolCalls.length) {
          await speakReply(response?.reply || response?.text || 'Done.');
          return;
        }

        const outputs = [];
        for (const call of toolCalls) {
          if (!call.name || !call.callId) continue;
          const result = await registry.execute(call.name, call.args);
          if (result.stopSpeaking) {
            await stopSpeaking();
            setStatus('idle');
          }
          if (result.requiresConfirmation) {
            pendingConfirmation.current = {
              callId: call.callId,
              tool: result.pendingTool,
              alternatives: result.alternatives || [],
              priorOutputs: outputs,
            };
            await speakReply(result.confirmationText);
            setStatus('confirming');
            return;
          }
          outputs.push({
            call_id: call.callId,
            output: {
              ok: true,
              message: result.message || '',
            },
          });
        }
        if (!outputs.length) {
          await speakReply(response?.reply || 'I could not complete that action.');
          return;
        }
        response = await continueToolTurn(outputs);
      }
      await speakReply('I stopped because that request needed too many steps.');
    },
    [continueToolTurn, registry, speakReply]
  );

  const processText = useCallback(
    async (rawText) => {
      const text = cleanTranscript(rawText);
      if (!text || busyRef.current) return;
      busyRef.current = true;
      setError('');
      setTranscript(text);
      try {
        const pending = pendingConfirmation.current;
        if (pending) {
          const answer = confirmationAnswer(text);
          if (answer === null) {
            await speakReply('Please say yes to confirm or no to cancel.');
            return;
          }
          pendingConfirmation.current = null;
          if (!answer) {
            if (pending.alternatives?.length) {
              const [next, ...remaining] = pending.alternatives;
              pendingConfirmation.current = {
                callId: pending.callId,
                tool: next.pendingTool,
                alternatives: remaining,
                priorOutputs: pending.priorOutputs || [],
              };
              await speakReply(next.confirmationText);
              setStatus('confirming');
              return;
            }
            setStatus('thinking');
            const response = await continueToolTurn([
              ...(pending.priorOutputs || []),
              {
                call_id: pending.callId,
                output: { ok: false, cancelled: true, message: 'The user cancelled.' },
              },
            ]);
            await handleAssistantResponse(response);
            return;
          }
          setStatus('thinking');
          const result = await registry.execute(pending.tool.name, pending.tool.args, {
            confirmed: true,
          });
          const response = await continueToolTurn([
            ...(pending.priorOutputs || []),
            {
              call_id: pending.callId,
              output: { ok: true, message: result.message || 'Completed.' },
            },
          ]);
          await handleAssistantResponse(response);
          return;
        }

        if (/^(stop|stop talking|be quiet)$/i.test(text)) {
          await stopSpeaking();
          setStatus('idle');
          return;
        }

        setStatus('thinking');
        const appContext = await registry.getContext();
        const response = await sendAssistantTurn({
          conversationId: conversationId.current,
          text,
          appContext,
        });
        await handleAssistantResponse(response);
      } catch (assistantError) {
        const message =
          assistantError.message || 'The voice assistant is unavailable right now.';
        setError(message);
        await speakReply(message);
      } finally {
        busyRef.current = false;
      }
    },
    [continueToolTurn, handleAssistantResponse, registry, speakReply]
  );

  const startRecording = useCallback(async () => {
    if (busyRef.current) return;
    const permission = await AudioModule.requestRecordingPermissionsAsync();
    if (!permission.granted) {
      setError('Microphone permission is required.');
      await speakReply('Microphone permission is required for voice control.');
      return;
    }
    await stopSpeaking();
    await recorder.prepareToRecordAsync();
    recorder.record();
    setStatus('listening');
    setError('');
  }, [recorder, speakReply]);

  const stopRecording = useCallback(async () => {
    if (status !== 'listening') return;
    setStatus('transcribing');
    try {
      await recorder.stop();
      const text = await transcribeAssistantAudio(recorder.uri);
      if (!text) {
        await speakReply('I did not hear a command.');
        return;
      }
      await processText(text);
    } catch (recordingError) {
      const message = recordingError.message || 'I could not process that recording.';
      setError(message);
      await speakReply(message);
    }
  }, [processText, recorder, speakReply, status]);

  const toggleRecording = useCallback(async () => {
    if (status === 'listening') {
      await stopRecording();
    } else if (!busyRef.current && !['thinking', 'transcribing'].includes(status)) {
      await startRecording();
    }
  }, [startRecording, status, stopRecording]);

  const cancel = useCallback(async () => {
    pendingConfirmation.current = null;
    busyRef.current = false;
    await stopSpeaking();
    if (status === 'listening') {
      await recorder.stop().catch(() => {});
    }
    setStatus('idle');
  }, [recorder, status]);

  const statusMessage = useMemo(() => {
    const labels = {
      idle: 'Ready',
      listening: 'Listening… tap again when finished',
      transcribing: 'Transcribing…',
      thinking: 'Thinking…',
      confirming: 'Waiting for confirmation',
      speaking: 'Speaking…',
    };
    return labels[status] || 'Ready';
  }, [status]);

  return {
    status,
    statusMessage,
    transcript,
    error,
    toggleRecording,
    cancel,
    processText,
  };
}
