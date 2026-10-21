/**
 * worker/ocrIngress.ts — OCR & Visual Ingress Pipeline
 *
 * Ingests images, screenshots, camera photos, and diagrams:
 * - Decodes base64 or binary image payloads
 * - Enforces 15MB size bounds
 * - Dispatches through swappable OCRProvider interface
 */

import { OCRProvider, ExtractionResult, OCRExtractionOptions } from './inputTypes';
import { MockOCRProvider } from './providers/mock/mockIngressProviders';
import { WorkersAiOcrProvider } from './providers/ocr/workersAiOcrProvider';

export class OCRIngress {
  private provider: OCRProvider;

  constructor(provider?: OCRProvider) {
    this.provider = provider || new MockOCRProvider();
  }

  static createDefault(env: Record<string, any>): OCRIngress {
    if (env.AI) {
      return new OCRIngress(new WorkersAiOcrProvider(env.AI));
    }
    return new OCRIngress(new MockOCRProvider());
  }

  async processImage(
    imageData: Uint8Array | ArrayBuffer | string,
    mimeType: string = 'image/png',
    options?: OCRExtractionOptions
  ): Promise<ExtractionResult> {
    let bytes: Uint8Array;

    if (typeof imageData === 'string') {
      const binaryString = atob(imageData.replace(/^data:image\/[^;]+;base64,/, ''));
      bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
    } else if (imageData instanceof ArrayBuffer) {
      bytes = new Uint8Array(imageData);
    } else {
      bytes = imageData;
    }

    if (bytes.byteLength === 0) {
      throw new Error('OCRIngress: Received empty image payload');
    }

    if (bytes.byteLength > 15 * 1024 * 1024) {
      throw new Error('OCRIngress: Image payload exceeds 15MB safety ceiling');
    }

    return await this.provider.extractText(bytes, mimeType, options);
  }
}
