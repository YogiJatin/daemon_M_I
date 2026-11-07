/**
 * scripts/pair_desktop.ts - Desktop Agent Pairing CLI (B3.2)
 *
 * Prompts or accepts --code and --name.
 * Calls /api/v1/desktop/pair.
 * Encrypts deviceToken with DPAPI via PowerShell ConvertFrom-SecureString.
 * Stores token in .desktop_token.enc with ACL restricted to current user.
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

const DEFAULT_SERVER_URL = "https://personal-ai-os.jatin-personal-ai.workers.dev";
const TOKEN_FILE = path.resolve(process.cwd(), ".desktop_token.enc");

async function main() {
  const args = process.argv.slice(2);
  let code = "";
  let name = `PC-${process.env.COMPUTERNAME || "Windows"}`;
  let serverUrl = DEFAULT_SERVER_URL;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--code" && args[i + 1]) code = args[++i];
    if (args[i] === "--name" && args[i + 1]) name = args[++i];
    if (args[i] === "--server" && args[i + 1]) serverUrl = args[++i];
  }

  if (!code) {
    console.log("Usage: npm run agent:pair -- --code <8-char-code> [--name <device-name>]");
    process.exit(1);
  }

  console.log(`Exchanging pairing code '${code}' with server at ${serverUrl}...`);

  const resp = await fetch(`${serverUrl}/api/v1/desktop/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, name }),
  });

  const data = (await resp.json().catch(() => ({}))) as any;
  if (!resp.ok || !data.success) {
    console.error(`Pairing failed: ${data.error || "Unknown error"}`);
    process.exit(1);
  }

  const deviceToken = data.deviceToken;
  console.log(`Device paired successfully! Device ID: ${data.deviceId}`);

  // Encrypt with DPAPI via Windows PowerShell ConvertFrom-SecureString
  try {
    const psScript = `
      $sec = ConvertTo-SecureString -String '${deviceToken}' -AsPlainText -Force;
      $enc = ConvertFrom-SecureString -SecureString $sec;
      Set-Content -Path '${TOKEN_FILE.replace(/\\/g, "\\\\")}' -Value $enc -NoNewline;
      $acl = Get-Acl '${TOKEN_FILE.replace(/\\/g, "\\\\")}';
      $acl.SetAccessRuleProtection($true, $false);
      $rule = New-Object System.Security.AccessControl.FileSystemAccessRule([System.Security.Principal.WindowsIdentity]::GetCurrent().Name, 'FullControl', 'Allow');
      $acl.SetAccessRule($rule);
      Set-Acl -Path '${TOKEN_FILE.replace(/\\/g, "\\\\")}' -AclObject $acl;
    `;
    execSync(`powershell -NoProfile -NonInteractive -Command "${psScript.replace(/\n/g, " ")}"`, { stdio: "ignore" });
    console.log(`Token encrypted via DPAPI and saved to ${TOKEN_FILE} (ACL restricted to current user).`);
  } catch (err: any) {
    console.warn(`DPAPI encryption fallback to local file: ${err.message}`);
    fs.writeFileSync(TOKEN_FILE, deviceToken, { encoding: "utf8", mode: 0o600 });
  }
}

main().catch(console.error);
