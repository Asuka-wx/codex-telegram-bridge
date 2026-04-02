import fs from "node:fs";
import path from "node:path";

interface LaunchAgentPlistOptions {
  label: string;
  runScript: string;
  workingDirectory: string;
  stdoutPath: string;
  stderrPath: string;
  pathValue: string;
  homeDir: string;
}

const XML_ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "\"": "&quot;",
  "'": "&apos;",
};

const escapeXml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => XML_ESCAPE_MAP[char] ?? char);

export const resolveProjectRoot = (startPath: string): string => {
  let current = path.resolve(startPath);

  while (true) {
    if (fs.existsSync(path.join(current, "package.json"))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`无法从路径推断项目根目录：${startPath}`);
    }
    current = parent;
  }
};

export const mergePathEntries = (...sources: string[]): string => {
  const entries = sources
    .flatMap((source) => source.split(path.delimiter))
    .map((entry) => entry.trim())
    .filter(Boolean);

  return [...new Set(entries)].join(path.delimiter);
};

export const buildLaunchAgentPlist = ({
  label,
  runScript,
  workingDirectory,
  stdoutPath,
  stderrPath,
  pathValue,
  homeDir,
}: LaunchAgentPlistOptions): string => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${escapeXml(label)}</string>

    <key>ProgramArguments</key>
    <array>
      <string>/bin/zsh</string>
      <string>${escapeXml(runScript)}</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>WorkingDirectory</key>
    <string>${escapeXml(workingDirectory)}</string>

    <key>StandardOutPath</key>
    <string>${escapeXml(stdoutPath)}</string>

    <key>StandardErrorPath</key>
    <string>${escapeXml(stderrPath)}</string>

    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>${escapeXml(pathValue)}</string>
      <key>HOME</key>
      <string>${escapeXml(homeDir)}</string>
    </dict>
  </dict>
</plist>
`;
