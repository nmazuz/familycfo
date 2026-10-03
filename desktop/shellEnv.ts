import { execFileSync } from 'child_process';
import { accessSync, constants } from 'fs';
import { delimiter, join } from 'path';

/**
 * An app opened from Finder / the Dock (or a Linux desktop launcher) gets only a minimal PATH (/usr/bin:/bin:…). `claude` (npm, Homebrew, ~/.local)
 * and Chrome helpers are on the PATH of the user's login shell, so read it once at start.
 */
export function loginShellPath(): string | null {
  // Windows apps get the user's PATH from the registry already
  if (process.platform === 'win32') return null;
  const shell = process.env.SHELL || '/bin/zsh';
  try {
    const out = execFileSync(shell, ['-ilc', 'printf "__FCFO__%s__FCFO__" "$PATH"'], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, DISABLE_AUTO_UPDATE: 'true' }, // oh-my-zsh: don't prompt for an update
    });
    return out.match(/__FCFO__(.*)__FCFO__/)?.[1] || null;
  } catch {
    return null;
  }
}

export function mergePaths(...paths: (string | undefined | null)[]): string {
  return [...new Set(paths.flatMap(p => (p ? p.split(delimiter) : [])).filter(Boolean))].join(delimiter);
}

/** The command's full path. On Windows also with an extension (claude.exe first: a .cmd needs a shell to run). */
export function findOnPath(command: string, path: string): string | null {
  const names = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''].map(ext => command + ext) : [command];
  for (const dir of path.split(delimiter)) {
    for (const name of names) {
      const file = join(dir, name);
      try { accessSync(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK); return file; } catch { /* next */ }
    }
  }
  return null;
}
