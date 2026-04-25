import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

/**
 * Rolling live-transcript store. Holds the most recent N committed
 * (final) chunks plus the current in-flight partial per speaker, so
 * the UI can show captions like a live broadcast — and so the user
 * can verify the transcription is actually capturing what they say.
 */

const HISTORY_LIMIT = 8;

export type TranscriptLine = {
  id: string;
  speaker_id: string;
  text: string;
  ts: number;
  is_final: boolean;
};

type TranscriptState = {
  history: TranscriptLine[];                       // most recent committed lines
  partials: Record<string, TranscriptLine | null>; // current partial per speaker
  thinkingUntil: number | null;                    // epoch ms — show "thinking" pulse until then

  pushPartial: (speaker_id: string, text: string) => void;
  pushFinal: (speaker_id: string, text: string) => void;
  noteAgentDispatched: () => void;
  noteAgentSettled: () => void;
  reset: () => void;
};

let _seq = 0;
const nextId = () => `tr-${Date.now().toString(36)}-${++_seq}`;

export const useTranscriptStore = create<TranscriptState>((set) => ({
  history: [],
  partials: {},
  thinkingUntil: null,

  pushPartial: (speaker_id, text) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    set((s) => ({
      partials: {
        ...s.partials,
        [speaker_id]: {
          id: `${speaker_id}-partial`,
          speaker_id,
          text: trimmed,
          ts: Date.now(),
          is_final: false,
        },
      },
    }));
  },

  pushFinal: (speaker_id, text) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    set((s) => {
      const partials = { ...s.partials };
      delete partials[speaker_id];
      const next: TranscriptLine = {
        id: nextId(),
        speaker_id,
        text: trimmed,
        ts: Date.now(),
        is_final: true,
      };
      const history = [...s.history, next].slice(-HISTORY_LIMIT);
      // Fire a default-7s "thinking" window so the canvas can show the
      // agent is working on the just-committed phrase.
      return {
        partials,
        history,
        thinkingUntil: Date.now() + 7000,
      };
    });
  },

  noteAgentDispatched: () => set({ thinkingUntil: Date.now() + 7000 }),
  noteAgentSettled: () => set({ thinkingUntil: null }),

  reset: () => set({ history: [], partials: {}, thinkingUntil: null }),
}));

export const useTranscriptHistory = () =>
  useTranscriptStore(useShallow((s) => s.history));

export const useTranscriptPartials = () =>
  useTranscriptStore(useShallow((s) => Object.values(s.partials).filter(Boolean) as TranscriptLine[]));

export const useThinking = () =>
  useTranscriptStore((s) => s.thinkingUntil !== null && s.thinkingUntil > Date.now());
