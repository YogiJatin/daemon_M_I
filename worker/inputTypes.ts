/**
 * worker/inputTypes.ts — Multimodal Ingress Layer Type System
 *
 * Core abstractions for the Operating System Ingress Layer:
 * - Content-addressed Attachments and Chunks
 * - Multi-provider abstractions (Speech, OCR, Document)
 * - Observation & Proposal classification
 * - Input Session lifecycle management
 */

export type InputSource =
  | 'telegram'
  | 'web_mic'
  | 'web_camera'
  | 'web_upload'
  | 'drag_drop'
  | 'command_bar'
  | 'share_target'
  | 'desktop_capture'
  | 'browser_extension'
  | 'api';

export type RawInputType = 'text' | 'audio' | 'image' | 'document';

export type IngressStatus =
  | 'received'
  | 'normalizing'
  | 'extracting'
  | 'interpreting'
  | 'proposed'
  | 'failed';

export type ProposalCategory =
  | 'task'
  | 'study_material'
  | 'calendar_proposal'
  | 'capture_note'
  | 'bookmark'
  | 'reference'
  | 'question'
  | 'document'
  | 'ignore';

export interface RawInput {
  source: InputSource;
  rawType: RawInputType;
  payload: string | Uint8Array; // Text string or binary buffer
  filename?: string;
  mimeType?: string;
  metadata?: Record<string, any>;
}

export interface AttachmentRecord {
  id: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  sha256Hash: string;
  storagePath?: string | null;
  metadata?: Record<string, any>;
  createdAt: string;
}

export interface AttachmentChunk {
  id: string;
  attachmentId: string;
  chunkIndex: number;
  chunkText: string;
  tokenCount: number;
  createdAt: string;
}

export interface InputSessionRecord {
  id: string;
  source: InputSource;
  rawType: RawInputType;
  status: IngressStatus;
  extractedText?: string | null;
  attachmentId?: string | null;
  proposalId?: string | null;
  errorMessage?: string | null;
  metadata?: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export interface ExtractionResult {
  text: string;
  mimeType: string;
  confidence: number; // 0.0 to 1.0
  provider: string;
  durationMs?: number;
  metadata?: Record<string, any>;
}

export interface InterpretationResult {
  category: ProposalCategory;
  candidateTitle: string;
  description?: string;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  proposedLocalDate?: string | null; // YYYY-MM-DD
  proposedLocalTime?: string | null; // HH:mm
  dateRole?: 'deadline' | 'event_start' | 'event_end' | 'reminder_time' | 'unknown';
  evidenceQuote: string;
  ambiguityReasons?: string;
  advisoryConfidence: number; // 0.0 to 1.0
  actionSummary: string;
}

// ---------------------------------------------------------------------------
// Provider Interfaces
// ---------------------------------------------------------------------------

export interface SpeechExtractionOptions {
  language?: string;
  promptHint?: string;
  temperature?: number;
}

export interface SpeechProvider {
  name: string;
  transcribe(audioData: Uint8Array | ArrayBuffer, mimeType: string, options?: SpeechExtractionOptions): Promise<ExtractionResult>;
}

export interface OCRExtractionOptions {
  languageHint?: string;
  detectOrientation?: boolean;
}

export interface OCRProvider {
  name: string;
  extractText(imageData: Uint8Array | ArrayBuffer, mimeType: string, options?: OCRExtractionOptions): Promise<ExtractionResult>;
}

export interface DocumentExtractionOptions {
  maxPages?: number;
  preserveFormatting?: boolean;
}

export interface DocumentProvider {
  name: string;
  extractDocument(docData: Uint8Array | ArrayBuffer | string, mimeType: string, options?: DocumentExtractionOptions): Promise<ExtractionResult>;
}
