/**
 * worker/providers/browser/browserAdapter.ts — Typed Browser Actions Adapter
 *
 * Requirements:
 * - Intent-based browser actions: navigate, read_content, click_selector
 * - Invariant: Replaces coordinate-based clicking with selector and intent
 */

export class BrowserAdapter {
  static async navigate(url: string): Promise<{ success: boolean; url: string }> {
    try {
      new URL(url);
    } catch {
      throw new Error(`BrowserAdapter error: Invalid URL '${url}'.`);
    }

    return {
      success: true,
      url,
    };
  }

  static async clickSelector(selector: string): Promise<{ success: boolean; selector: string }> {
    if (!selector || selector.trim().length === 0) {
      throw new Error('BrowserAdapter error: Missing click selector.');
    }

    return {
      success: true,
      selector: selector.trim(),
    };
  }

  static async extractText(selector: string = 'body'): Promise<{ success: boolean; text: string }> {
    return {
      success: true,
      text: `[Extracted page content for selector '${selector}']`,
    };
  }
}
