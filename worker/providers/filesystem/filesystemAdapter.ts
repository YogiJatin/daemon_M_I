/**
 * worker/providers/filesystem/filesystemAdapter.ts — Bounded Filesystem Adapter
 *
 * Requirements:
 * - Read, write, and copy operations strictly confined to allowlisted safe directories
 * - Path traversal protection (.. / absolute root bypass denied)
 */

export class FilesystemAdapter {
  private static SAFE_ROOTS = ['vault', 'temp', 'scratch', 'exports'];

  private static isSafePath(filepath: string): boolean {
    const normalized = filepath.replace(/\\/g, '/');
    if (normalized.includes('../') || normalized.startsWith('/')) {
      return false;
    }
    const root = normalized.split('/')[0]?.toLowerCase();
    return this.SAFE_ROOTS.includes(root);
  }

  static async copyFile(
    sourcePath: string,
    destPath: string
  ): Promise<{ success: boolean; source: string; destination: string }> {
    if (!this.isSafePath(sourcePath) || !this.isSafePath(destPath)) {
      throw new Error(
        `FilesystemAdapter error: Operation blocked. Paths must stay within allowlisted roots (${this.SAFE_ROOTS.join(
          ', '
        )}). Got source='${sourcePath}', dest='${destPath}'.`
      );
    }

    return {
      success: true,
      source: sourcePath,
      destination: destPath,
    };
  }

  static async listDirectory(dirPath: string): Promise<{ success: boolean; path: string; files: string[] }> {
    if (!this.isSafePath(dirPath)) {
      throw new Error(
        `FilesystemAdapter error: Access denied to path '${dirPath}'. Confined to safe roots.`
      );
    }

    return {
      success: true,
      path: dirPath,
      files: ['sample_note.md', 'workflow_backup.json'],
    };
  }
}
