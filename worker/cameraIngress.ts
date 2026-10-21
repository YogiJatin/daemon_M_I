/**
 * worker/cameraIngress.ts — Permission-Gated Camera Capture Ingress
 *
 * Requirements:
 * - Permission-gated still, document, and whiteboard captures
 * - Content-addressing via SHA-256 attachment service
 * - Routes into unified InputRouter pipeline (proposal-first)
 * - Emits CAMERA_CAPTURE_STARTED and CAMERA_CAPTURE_COMPLETED audit events
 */

import { CameraProvider, CameraCaptureMode } from './cameraProvider';
import { AttachmentService } from './attachmentService';
import { InputRouter } from './inputRouter';
import { AuditService } from './auditService';

export interface CameraIngressResult {
  captureId: string;
  attachmentId: string;
  proposalId: string | null;
  mode: CameraCaptureMode;
  sha256Hash: string;
  byteSize: number;
  timestamp: string;
}

export class CameraIngressService {
  static async captureAndIngest(
    db: D1Database,
    provider: CameraProvider,
    mode: CameraCaptureMode = 'still',
    options: {
      candidateTitle?: string;
      deviceInfo?: string;
    } = {},
    env: Record<string, any> = {},
    now: Date = new Date()
  ): Promise<CameraIngressResult> {
    const hasPermission = await provider.isPermissionGranted();
    if (!hasPermission) {
      throw new Error('Camera capture blocked: permission not granted by owner.');
    }

    const captureId = `cam_${crypto.randomUUID()}`;
    const nowIso = now.toISOString();

    // Audit capture start
    await AuditService.emit(
      db,
      {
        eventType: 'CAMERA_CAPTURE_STARTED',
        entityType: 'camera_capture',
        entityId: captureId,
        actor: 'owner',
        payload: { captureId, mode, provider: provider.name },
        metadata: { mode },
      },
      env
    );

    // 1. Capture frame from provider
    const snapshot = await provider.capture(mode);

    // 2. Content-addressed storage in attachments table
    const filename = `camera_${mode}_${now.getTime()}.${snapshot.mimeType === 'image/png' ? 'png' : 'jpg'}`;
    const attResult = await AttachmentService.getOrCreateAttachment(
      db,
      filename,
      snapshot.mimeType,
      snapshot.bytes,
      { source: 'camera', mode, deviceInfo: options.deviceInfo || snapshot.deviceLabel },
      now
    );

    // 3. Route into unified Multimodal Ingress pipeline
    const inputRes = await InputRouter.routeInput(
      db,
      {
        rawType: 'image',
        source: 'web_upload',
        payload: snapshot.bytes,
        filename,
        mimeType: snapshot.mimeType,
        metadata: {
          deviceInfo: options.deviceInfo || snapshot.deviceLabel,
          mode,
        },
      },
      env,
      now
    );

    // 4. Record camera capture record
    await db
      .prepare(
        `INSERT INTO camera_captures (id, mode, attachment_id, proposal_id, device_info, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(
        captureId,
        mode,
        attResult.attachment.id,
        inputRes.proposalId || null,
        options.deviceInfo || snapshot.deviceLabel || null,
        nowIso
      )
      .run();

    // 5. Audit capture completion
    await AuditService.emit(
      db,
      {
        eventType: 'CAMERA_CAPTURE_COMPLETED',
        entityType: 'camera_capture',
        entityId: captureId,
        actor: 'owner',
        payload: {
          captureId,
          attachmentId: attResult.attachment.id,
          proposalId: inputRes.proposalId || null,
          mode,
          sha256Hash: attResult.attachment.sha256Hash,
        },
        metadata: { captureId, attachmentId: attResult.attachment.id },
      },
      env
    );

    return {
      captureId,
      attachmentId: attResult.attachment.id,
      proposalId: inputRes.proposalId || null,
      mode,
      sha256Hash: attResult.attachment.sha256Hash,
      byteSize: snapshot.byteSize,
      timestamp: nowIso,
    };
  }
}
