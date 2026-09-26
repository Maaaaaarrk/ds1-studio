import { isTauri } from '../vfs/tauri';

/** Where releases, the update feed and bug reports live. */
export const REPO = 'RoofooEvazan/ds1-studio';
export const REPO_URL = `https://github.com/${REPO}`;
export const APP_VERSION = __APP_VERSION__;
export const GIT_COMMIT = __GIT_COMMIT__;
export const BUILD_DATE = __BUILD_DATE__;

export interface UpdateInfo {
  version: string;
  notes: string;
  date?: string;
  /** Release page, for manual download. */
  url: string;
  /** Present when the app can download, install and restart by itself (installed via the Windows installer or AppImage). */
  install?: (onProgress: (done: number, total: number | null) => void) => Promise<void>;
}

/** Compares dotted versions ("0.10.2" > "0.9.9"); a leading "v" is ignored. */
export function newerThan(a: string, b: string): boolean {
  const pa = a.replace(/^v/, '').split(/[.-]/).map((x) => Number(x) || 0);
  const pb = b.replace(/^v/, '').split(/[.-]/).map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

/** The latest GitHub release, if newer than this build. */
async function latestRelease(): Promise<UpdateInfo | null> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
  if (res.status === 404) return null; // no releases yet
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const r = (await res.json()) as { tag_name: string; body?: string; published_at?: string; html_url: string };
  return newerThan(r.tag_name, APP_VERSION) ? { version: r.tag_name.replace(/^v/, ''), notes: r.body ?? '', date: r.published_at, url: r.html_url } : null;
}

/**
 * Checks GitHub for a newer version. In the desktop app the signed updater is tried first (it can install and
 * restart); installs it can't update (e.g. a .deb/.rpm package) still get the release link.
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (isTauri) {
    try {
      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check();
      if (!update) return null;
      return {
        version: update.version,
        notes: update.body ?? '',
        date: update.date,
        url: `${REPO_URL}/releases/tag/v${update.version}`,
        install: async (onProgress) => {
          let done = 0;
          let total: number | null = null;
          await update.downloadAndInstall((e) => {
            if (e.event === 'Started') total = e.data.contentLength ?? null;
            if (e.event === 'Progress') done += e.data.chunkLength;
            onProgress(done, total);
          });
          const { relaunch } = await import('@tauri-apps/plugin-process');
          await relaunch();
        },
      };
    } catch {
      // Not updatable in place (package-manager install, no signed feed yet…): fall back to the release list.
    }
  }
  return latestRelease();
}

/** Opens a web page in the user's browser. */
export async function openExternal(url: string): Promise<void> {
  try {
    if (isTauri) {
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(url);
    } else window.open(url, '_blank', 'noopener');
  } catch (e) {
    // Never fail silently: show the address so it can be opened by hand.
    window.prompt(`Couldn't open your web browser (${String(e)}). Copy this address instead:`, url);
  }
}

export function platformName(): string {
  const ua = navigator.userAgent;
  if (/Windows NT 10/.test(ua)) return 'Windows 10/11';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Linux/.test(ua)) return 'Linux';
  if (/Mac/.test(ua)) return 'macOS';
  return 'Unknown OS';
}

/** A pre-filled "new issue" link: the reporter adds what happened and submits; GitHub notifies the maintainer. */
export function bugReportUrl(context: { map?: string | null; title?: string }): string {
  const body = [
    '### What happened?',
    '',
    '<!-- Describe the problem. Screenshots help a lot: paste them straight into this box. -->',
    '',
    '### Steps to reproduce',
    '',
    '1. ',
    '',
    '### What did you expect?',
    '',
    '',
    '### Environment',
    `- DS1 Studio ${APP_VERSION} (${GIT_COMMIT}, built ${BUILD_DATE})`,
    `- ${isTauri ? 'Desktop app' : 'Browser'} on ${platformName()}`,
    context.map ? `- Map: \`${context.map}\`` : '- Map: (none open)',
  ].join('\n');
  const q = new URLSearchParams({ title: context.title ?? '[Bug] ', body, labels: 'bug' });
  return `${REPO_URL}/issues/new?${q}`;
}
