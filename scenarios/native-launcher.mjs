// Native messaging host launchers that record each host's pid (shared test 2, D68).
// The browser starts the launcher; it writes its own pid to <pidDirectory>/<name>-<pid>.pid
// and then execs the app's production host, so the pid recorded is the host's own process
// (its native port, its transport). Test code can then end exactly that process without
// knowing anything about the product. POSIX sh only, so the same launcher works on Linux
// and macOS.
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const NAME = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/;  // Chrome's native messaging host name rule
const quote = value => `'${String(value).replaceAll("'", `'\\''`)}'`;

// Writes <manifestDirectory>/<name>.json (Chrome's NativeMessagingHosts entry) pointing at
// <launcherDirectory>/<name>.launcher. command is the host's argv; the browser's own
// arguments (the caller origin, a parent window) follow it.
export async function writeNativeHost({ manifestDirectory, launcherDirectory = manifestDirectory, pidDirectory,
  name, command, allowedOrigins, description = 'Cassini test host' }) {
  if (!NAME.test(name)) throw new Error(`invalid native host name ${name}`);
  if (!Array.isArray(command) || !command.length || !command.every(part => typeof part === 'string' && part))
    throw new Error('command is the host argv, a non-empty array of strings');
  for (const directory of [manifestDirectory, launcherDirectory, pidDirectory])
    if (!path.isAbsolute(directory)) throw new Error(`${directory}: an absolute directory`);
  await Promise.all([manifestDirectory, launcherDirectory, pidDirectory].map(d => mkdir(d, { recursive: true })));
  const launcher = path.join(launcherDirectory, `${name}.launcher`);
  // name is a host name (letters, digits, _ and .), safe inside double quotes; the
  // directory is single-quoted. The pid file appears whole (rename), never half-written.
  await writeFile(launcher, [
    '#!/bin/sh',
    '# Written by cassini-browser-protocol scenarios/native-launcher.mjs: record this pid, then exec the host.',
    'umask 077',
    `pids=${quote(pidDirectory)}`,
    `printf '%s\\n' "$$" > "$pids/.${name}-$$.tmp" || exit 70`,
    `mv -f "$pids/.${name}-$$.tmp" "$pids/${name}-$$.pid" || exit 70`,
    `exec ${command.map(quote).join(' ')} "$@"`,
    '',
  ].join('\n'), { mode: 0o700 });
  await chmod(launcher, 0o700);
  const manifest = path.join(manifestDirectory, `${name}.json`);
  await writeFile(manifest, JSON.stringify({ name, description, path: launcher, type: 'stdio', allowed_origins: allowedOrigins }));
  return { manifest, launcher, pidDirectory, name, command };
}

function alive(pid) {
  try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return false; if (error.code !== 'EPERM') throw error; }
  return true;
}

// On Linux the process must still be the host the launcher exec'd (not a zombie, its argv
// holding the command in order: a #! script's interpreter comes first), so a recycled pid
// is never mistaken for it. Elsewhere liveness is kill(pid, 0).
async function stillHost(pid, command) {
  if (!alive(pid)) return false;
  let stat, argv;
  try {
    stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
  } catch (error) {
    if (error.code === 'ENOENT' && process.platform !== 'linux') return true;
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z')) return false;
  let at = 0;
  for (const part of argv) if (part === command[at]) at++;
  return at === command.length;
}

// Every pid a launcher recorded for this host, oldest file order, with whether it is live.
export async function hostPids({ pidDirectory, name, command }) {
  const pattern = new RegExp(`^${name.replaceAll('.', '\\.')}-(\\d+)\\.pid$`);
  let entries;
  try { entries = await readdir(pidDirectory); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const pids = entries.map(entry => pattern.exec(entry)).filter(Boolean).map(match => Number(match[1]));
  return Promise.all(pids.sort((a, b) => a - b).map(async pid => ({ pid, live: await stillHost(pid, command) })));
}

export async function livePids(host) {
  return (await hostPids(host)).filter(entry => entry.live).map(entry => entry.pid);
}
