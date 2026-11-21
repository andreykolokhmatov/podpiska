import path from 'node:path';
import { fileURLToPath } from 'node:url';

const normalize = (file: string, platform: NodeJS.Platform): string => {
  const resolved = path.resolve(file);
  // Windows paths are case-insensitive and argv may differ in drive-letter case.
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
};

/** True when the module at `moduleUrl` is the script node/tsx was started with. */
export function isEntryPoint(
  moduleUrl: string,
  entry: string | undefined = process.argv[1],
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (entry === undefined || entry === '') return false;
  let modulePath: string;
  try {
    modulePath = fileURLToPath(moduleUrl);
  } catch {
    return false;
  }
  return normalize(modulePath, platform) === normalize(entry, platform);
}
