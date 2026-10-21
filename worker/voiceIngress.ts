/**
 * worker/voiceIngress.ts — Voice & Audio Ingress Pipeline
 *
 * Ingests audio streams, voice notes, and dictations:
 * - Decodes base64 or binary audio payloads
 * - Bounded audio duration and size checks
 * - Dispatches through swappable SpeechProvider interface
 */

import { SpeechProvider, ExtractionResult, SpeechExtractionOptions } from './inputTypes';
import { MockSpeechProvider } from './providers/mock/mockIngressProviders';
import { GroqWhisperProvider } from './providers/speech/groqWhisperProvider';
import { WorkersAiWhisperProvider } from './providers/speech/workersAiWhisperProvider';

export class VoiceIngress {
  private provider: SpeechProvider;

  constructor(provider?: SpeechProvider) {
    this.provider = provider || new MockSpeechProvider();
  }

  static createDefault(env: Record<string, any>): VoiceIngress {
    if (env.GROQ_API_KEY) {
      return new VoiceIngress(new GroqWhisperProvider(env.GROQ_API_KEY));
    }
    if (env.AI) {
      return new VoiceIngress(new WorkersAiWhisperProvider(env.AI));
    }
    return new VoiceIngress(new MockSpeechProvider());
  }

  async processAudio(
    audioData: Uint8Array | ArrayBuffer | string,
    mimeType: string = 'audio/ogg',
    options?: SpeechExtractionOptions
  ): Promise<ExtractionResult> {
    let bytes: Uint8Array;

    if (typeof audioData === 'string') {
      // Decode base64
      const binaryString = atob(audioData.replace(/^data:audio\/[^;]+;base64,/, ''));
      bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
    } else if (audioData instanceof ArrayBuffer) {
      bytes = new Uint8Array(audioData);
    } else {
      bytes = audioData;
    }

    if (bytes.byteLength === 0) {
      throw new Error('VoiceIngress: Received empty audio payload');
    }

    // Free tier bounding: 25MB ceiling
    if (bytes.byteLength > 25 * 1024 * 1024) {
      throw new Error('VoiceIngress: Audio payload exceeds 25MB safety ceiling');
    }

    return await this.provider.transcribe(bytes, mimeType, options);
  }
}
