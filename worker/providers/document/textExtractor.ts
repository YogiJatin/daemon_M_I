/**
 * worker/providers/document/textExtractor.ts — Deterministic Text & Document Extractor
 *
 * Lightweight, zero-native-dependency extractor compatible with Cloudflare Workers:
 * - Plain text and Markdown (.txt, .md)
 * - Basic PDF stream text extraction (/BT ... /ET, (text) Tj, [(t) (e) (x) (t)] TJ)
 * - Basic DOCX text extraction (w:t tags from word/document.xml)
 */

import { DocumentProvider, ExtractionResult, DocumentExtractionOptions } from '../../inputTypes';

export class StandardTextExtractor implements DocumentProvider {
  name = 'standard_document_extractor';

  async extractDocument(
    docData: Uint8Array | ArrayBuffer | string,
    mimeType: string,
    _options: DocumentExtractionOptions = {}
  ): Promise<ExtractionResult> {
    const start = Date.now();

    // 1. Text / Markdown / String
    if (typeof docData === 'string') {
      return {
        text: docData.trim(),
        mimeType: mimeType || 'text/plain',
        confidence: 1.0,
        provider: this.name,
        durationMs: Date.now() - start,
      };
    }

    const bytes = docData instanceof ArrayBuffer ? new Uint8Array(docData) : docData;

    // 2. Plain text / Markdown detection
    if (
      mimeType.startsWith('text/') ||
      mimeType === 'application/json' ||
      mimeType === 'application/javascript'
    ) {
      const decoded = new TextDecoder('utf-8').decode(bytes);
      return {
        text: decoded.trim(),
        mimeType: mimeType || 'text/plain',
        confidence: 1.0,
        provider: this.name,
        durationMs: Date.now() - start,
      };
    }

    // 3. PDF Parsing
    if (mimeType === 'application/pdf' || this.isPdf(bytes)) {
      const extracted = this.extractPdfText(bytes);
      return {
        text: extracted,
        mimeType: 'application/pdf',
        confidence: extracted.length > 0 ? 0.92 : 0.4,
        provider: this.name,
        durationMs: Date.now() - start,
      };
    }

    // 4. DOCX Parsing (Zip containing word/document.xml)
    if (
      mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      this.isZip(bytes)
    ) {
      const extracted = this.extractDocxText(bytes);
      return {
        text: extracted,
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        confidence: extracted.length > 0 ? 0.95 : 0.5,
        provider: this.name,
        durationMs: Date.now() - start,
      };
    }

    // 5. Fallback: UTF-8 conversion with non-printable character filtering
    const fallbackText = new TextDecoder('utf-8')
      .decode(bytes)
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    return {
      text: fallbackText,
      mimeType: mimeType || 'application/octet-stream',
      confidence: 0.6,
      provider: this.name,
      durationMs: Date.now() - start,
    };
  }

  private isPdf(bytes: Uint8Array): boolean {
    return (
      bytes.length > 4 &&
      bytes[0] === 0x25 && // %
      bytes[1] === 0x50 && // P
      bytes[2] === 0x44 && // D
      bytes[3] === 0x46    // F
    );
  }

  private isZip(bytes: Uint8Array): boolean {
    return (
      bytes.length > 4 &&
      bytes[0] === 0x50 && // P
      bytes[1] === 0x4b && // K
      (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)
    );
  }

  /**
   * Extracts text tokens from standard PDF text blocks (/BT ... /ET).
   */
  private extractPdfText(bytes: Uint8Array): string {
    const raw = new TextDecoder('latin1').decode(bytes);
    const textPieces: string[] = [];

    // Match text blocks inside BT ... ET
    const blockRegex = /BT[\s\S]*?ET/g;
    let match: RegExpExecArray | null;

    while ((match = blockRegex.exec(raw)) !== null) {
      const block = match[0];
      // Match (string) Tj
      const tjRegex = /\(([^)]+)\)\s*Tj/g;
      let tjMatch: RegExpExecArray | null;
      while ((tjMatch = tjRegex.exec(block)) !== null) {
        textPieces.push(tjMatch[1]);
      }

      // Match [(array)] TJ
      const arrayTjRegex = /\[([^\]]+)\]\s*TJ/g;
      let arrMatch: RegExpExecArray | null;
      while ((arrMatch = arrayTjRegex.exec(block)) !== null) {
        const inner = arrMatch[1];
        const innerStrings = inner.match(/\(([^)]+)\)/g);
        if (innerStrings) {
          textPieces.push(innerStrings.map((s) => s.slice(1, -1)).join(''));
        }
      }
    }

    if (textPieces.length === 0) {
      // Fallback: look for all literal strings (text) that look like words
      const literalStrings = raw.match(/\(([A-Za-z0-9 .,:;!?\n\r-]{3,})\)/g);
      if (literalStrings) {
        return literalStrings.map((s) => s.slice(1, -1)).join(' ').trim();
      }
    }

    return textPieces.join('\n').trim();
  }

  /**
   * Extracts text from DOCX XML paragraph (<w:t> tags).
   */
  private extractDocxText(bytes: Uint8Array): string {
    const raw = new TextDecoder('latin1').decode(bytes);
    // Find word/document.xml entry in uncompressed stream or find all <w:t> strings
    const wtRegex = /<w:t(?:\s+[^>]*)?>([^<]+)<\/w:t>/g;
    const pieces: string[] = [];
    let match: RegExpExecArray | null;

    while ((match = wtRegex.exec(raw)) !== null) {
      pieces.push(match[1]);
    }

    return pieces.join(' ').replace(/\s+/g, ' ').trim();
  }
}
