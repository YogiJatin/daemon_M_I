import { OCRProvider, ExtractionResult, OCRExtractionOptions } from '../../inputTypes';

export class WorkersAiOcrProvider implements OCRProvider {
  name = 'workers_ai_vision';
  private aiBinding: any;

  constructor(aiBinding?: any) {
    this.aiBinding = aiBinding;
  }

  async extractText(
    imageData: Uint8Array | ArrayBuffer,
    _mimeType: string,
    _options: OCRExtractionOptions = {}
  ): Promise<ExtractionResult> {
    const start = Date.now();

    if (!this.aiBinding) {
      throw new Error('WorkersAiOcrProvider: Cloudflare AI binding not available');
    }

    const input = [...new Uint8Array(imageData)];
    const res = await this.aiBinding.run('@cf/meta/llama-3.2-11b-vision-instruct', {
      image: input,
      prompt: 'Extract and transcribe all legible text, dates, times, tasks, and key notes from this image verbatim without summarizing.',
      max_tokens: 1024,
    });

    const description = res.response || res.description || '';
    return {
      text: description,
      mimeType: 'text/plain',
      confidence: 0.88,
      provider: this.name,
      durationMs: Date.now() - start,
    };
  }
}
