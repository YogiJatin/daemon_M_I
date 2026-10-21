/**
 * worker/cameraProvider.ts — Camera Capture Provider Abstractions
 *
 * Requirements:
 * - Permission-gated camera capture
 * - Modes: still, document, whiteboard, burst
 * - Deterministic mock implementations for unit testing
 */

export type CameraCaptureMode = 'still' | 'document' | 'whiteboard' | 'burst';

export interface CameraSnapshot {
  mode: CameraCaptureMode;
  mimeType: 'image/jpeg' | 'image/png';
  bytes: Uint8Array;
  byteSize: number;
  width?: number;
  height?: number;
  capturedAt: string;
  deviceLabel?: string;
}

export interface CameraProvider {
  name: string;
  isPermissionGranted(): Promise<boolean>;
  capture(mode: CameraCaptureMode): Promise<CameraSnapshot>;
}

export class MockCameraProvider implements CameraProvider {
  name = 'mock_camera';
  private permissionGranted: boolean;

  constructor(permissionGranted: boolean = true) {
    this.permissionGranted = permissionGranted;
  }

  setPermission(granted: boolean) {
    this.permissionGranted = granted;
  }

  async isPermissionGranted(): Promise<boolean> {
    return this.permissionGranted;
  }

  async capture(mode: CameraCaptureMode = 'still'): Promise<CameraSnapshot> {
    if (!this.permissionGranted) {
      throw new Error('Camera access denied: permission not granted.');
    }

    const dummyText = `MOCK_CAMERA_FRAME_${mode.toUpperCase()}_${Date.now()}`;
    const bytes = new TextEncoder().encode(dummyText);

    return {
      mode,
      mimeType: 'image/jpeg',
      bytes,
      byteSize: bytes.byteLength,
      width: 1920,
      height: 1080,
      capturedAt: new Date().toISOString(),
      deviceLabel: 'Mock Virtual Camera',
    };
  }
}
