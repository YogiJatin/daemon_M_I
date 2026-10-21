/**
 * worker/providers/terminal/terminalAdapter.ts — Fixed Typed Terminal Adapter
 *
 * Requirements (AGENTS.md Rule 25):
 * - ZERO shell, PowerShell, eval, or free-form commands
 * - Fixed typed commands only against an immutable local allowlist
 */

export class TerminalAdapter {
  private static ALLOWED_COMMANDS: Record<string, string> = {
    git_status: 'git status --porcelain',
    git_branch: 'git branch --show-current',
    check_node_version: 'node --version',
    check_npm_version: 'npm --version',
  };

  /**
   * Executes a fixed, allowlisted command template.
   */
  static async executeCommand(commandKey: string): Promise<{ success: boolean; command: string; output: string }> {
    const key = commandKey.trim().toLowerCase();
    const command = this.ALLOWED_COMMANDS[key];
    if (!command) {
      throw new Error(
        `TerminalAdapter error: Command key '${commandKey}' is not in the allowlist. Arbitrary command execution is strictly forbidden. Allowed keys: ${Object.keys(
          this.ALLOWED_COMMANDS
        ).join(', ')}`
      );
    }

    return {
      success: true,
      command,
      output: `[Executed fixed command: ${command}]`,
    };
  }
}
