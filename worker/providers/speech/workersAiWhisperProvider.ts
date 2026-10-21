import { SpeechProvider, ExtractionResult, SpeechExtractionOptions } from '../../inputTypes';

export class WorkersAiWhisperProvider implements SpeechProvider {
  name = 'workers_ai_whisper';
  private aiBinding: any;

  constructor(aiBinding?: any) {
    this.aiBinding = aiBinding;
  }

  async transcribe(
    audioData: Uint8Array | ArrayBuffer,
    _mimeType: string,
    _options: SpeechExtractionOptions = {}
  ): Promise<ExtractionResult> {
    const start = Date.now();

    if (!this.aiBinding) {
      throw new Error('WorkersAiWhisperProvider: Cloudflare AI binding not available');
    }

    const input = [...new Uint8Array(audioData)];
    const res = await this.aiBinding.run('@cf/openai/whisper', {
      audio: input,
    });

    return {
      text: res.text || '',
      mimeType: 'text/plain',
      confidence: 0.9,
      provider: this.name,
      durationMs: Date.now() - start,
      metadata: {
        vtt: res.vtt,
      },
    };
  }
}
