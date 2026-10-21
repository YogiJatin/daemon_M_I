/**
 * worker/providers/desktop/desktopAdapter.ts — Typed Desktop Actions Adapter
 *
 * Requirements (AGENTS.md Rules 24–30):
 * - Fixed typed adapters only (no shell, no eval, no free-form paths)
 * - Allowlisted app names -> fixed paths
 * - Media keys: play_pause, next, prev, volume_up, volume_down, mute
 */

export class DesktopAdapter {
  private static ALLOWED_APPS: Record<string, string> = {
    spotify: 'spotify:',
    notepad: 'notepad.exe',
    chrome: 'chrome.exe',
    calculator: 'calc.exe',
  };

  private static ALLOWED_MEDIA_KEYS = [
    'play_pause',
    'next',
    'prev',
    'volume_up',
    'volume_down',
    'mute',
  ];

  /**
   * Safe launch of an allowlisted application.
   */
  static async launchApp(appName: string): Promise<{ success: boolean; target: string }> {
    const key = appName.trim().toLowerCase();
    const target = this.ALLOWED_APPS[key];
    if (!target) {
      throw new Error(
        `DesktopAdapter error: App '${appName}' is not in the desktop allowlist. Allowed apps: ${Object.keys(
          this.ALLOWED_APPS
        ).join(', ')}`
      );
    }

    return {
      success: true,
      target,
    };
  }

  /**
   * Media key trigger simulation.
   */
  static async sendMediaKey(key: string): Promise<{ success: boolean; key: string }> {
    const normalizedKey = key.trim().toLowerCase();
    if (!this.ALLOWED_MEDIA_KEYS.includes(normalizedKey)) {
      throw new Error(
        `DesktopAdapter error: Media key '${key}' is not allowed. Allowed keys: ${this.ALLOWED_MEDIA_KEYS.join(
          ', '
        )}`
      );
    }

    return {
      success: true,
      key: normalizedKey,
    };
  }
}
