import { SpeechProvider, ExtractionResult, SpeechExtractionOptions } from '../../inputTypes';

export class GroqWhisperProvider implements SpeechProvider {
  name = 'groq_whisper';
  private apiKey: string;
  private endpoint: string;

  constructor(apiKey: string = '', endpoint: string = 'https://api.groq.com/openai/v1/audio/transcriptions') {
    this.apiKey = apiKey;
    this.endpoint = endpoint;
  }

  async transcribe(
    audioData: Uint8Array | ArrayBuffer,
    mimeType: string,
    options: SpeechExtractionOptions = {}
  ): Promise<ExtractionResult> {
    const start = Date.now();

    if (!this.apiKey) {
      throw new Error('GroqWhisperProvider: Missing GROQ_API_KEY');
    }

    const formData = new FormData();
    const blob = new Blob([audioData as any], { type: mimeType || 'audio/ogg' });
    formData.append('file', blob, 'audio.ogg');
    formData.append('model', 'whisper-large-v3-turbo');
    if (options.language) formData.append('language', options.language);
    if (options.promptHint) formData.append('prompt', options.promptHint);

    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: formData,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Groq Whisper failed (${res.status}): ${errText}`);
    }

    const json = (await res.json()) as any;
    return {
      text: json.text || '',
      mimeType: 'text/plain',
      confidence: 0.95,
      provider: this.name,
      durationMs: Date.now() - start,
      metadata: {
        language: json.language,
        duration: json.duration,
      },
    };
  }
}
