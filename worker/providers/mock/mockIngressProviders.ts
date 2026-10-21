/**
 * worker/providers/mock/mockIngressProviders.ts — Deterministic Ingress Test Mocks
 *
 * Implements Rule 4: Unit tests and offline environments must never require external APIs.
 * Supports configurable canned outputs, simulated error responses, and predictable latency.
 */

import {
  SpeechProvider,
  OCRProvider,
  DocumentProvider,
  ExtractionResult,
  SpeechExtractionOptions,
  OCRExtractionOptions,
  DocumentExtractionOptions,
} from '../../inputTypes';

export class MockSpeechProvider implements SpeechProvider {
  name = 'mock_speech';
  cannedText: string;
  shouldFail: boolean;

  constructor(cannedText: string = 'Remember to submit physics lab assignment by Friday 5 PM', shouldFail: boolean = false) {
    this.cannedText = cannedText;
    this.shouldFail = shouldFail;
  }

  async transcribe(
    _audioData: Uint8Array | ArrayBuffer,
    _mimeType: string,
    _options?: SpeechExtractionOptions
  ): Promise<ExtractionResult> {
    if (this.shouldFail) {
      throw new Error('MockSpeechProvider: Simulated transcription network error');
    }

    return {
      text: this.cannedText,
      mimeType: 'text/plain',
      confidence: 0.98,
      provider: this.name,
      durationMs: 45,
      metadata: {
        simulated: true,
        wordCount: this.cannedText.split(/\s+/).length,
      },
    };
  }
}

export class MockOCRProvider implements OCRProvider {
  name = 'mock_ocr';
  cannedText: string;
  shouldFail: boolean;

  constructor(cannedText: string = 'Discrete Mathematics Exam Date: 2026-11-15 Hall B Room 402', shouldFail: boolean = false) {
    this.cannedText = cannedText;
    this.shouldFail = shouldFail;
  }

  async extractText(
    _imageData: Uint8Array | ArrayBuffer,
    _mimeType: string,
    _options?: OCRExtractionOptions
  ): Promise<ExtractionResult> {
    if (this.shouldFail) {
      throw new Error('MockOCRProvider: Simulated OCR failure');
    }

    return {
      text: this.cannedText,
      mimeType: 'text/plain',
      confidence: 0.94,
      provider: this.name,
      durationMs: 35,
      metadata: {
        simulated: true,
      },
    };
  }
}

export class MockDocumentProvider implements DocumentProvider {
  name = 'mock_document';
  cannedText: string;
  shouldFail: boolean;

  constructor(cannedText: string = '# Operating Systems Syllabus\n\nChapter 1: Process Scheduling\nChapter 2: Memory Management\nHomework 1 due next Tuesday.', shouldFail: boolean = false) {
    this.cannedText = cannedText;
    this.shouldFail = shouldFail;
  }

  async extractDocument(
    _docData: Uint8Array | ArrayBuffer | string,
    _mimeType: string,
    _options?: DocumentExtractionOptions
  ): Promise<ExtractionResult> {
    if (this.shouldFail) {
      throw new Error('MockDocumentProvider: Simulated document parsing error');
    }

    return {
      text: this.cannedText,
      mimeType: 'text/markdown',
      confidence: 0.99,
      provider: this.name,
      durationMs: 20,
      metadata: {
        simulated: true,
      },
    };
  }
}
