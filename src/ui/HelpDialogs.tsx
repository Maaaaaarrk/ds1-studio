import { useEffect, useState } from 'react';
import { APP_VERSION, BUILD_DATE, checkForUpdate, GIT_COMMIT, openExternal, platformName, REPO_URL, type UpdateInfo } from '../app/updates';
import { isTauri } from '../vfs/tauri';
import { Modal } from './Dialogs';

/** Help → About: version and build information. */
export function AboutDialog({ onClose }: { onClose: () => void }) {
  const rows: [string, string][] = [
    ['Version', APP_VERSION],
    ['Build', `${GIT_COMMIT} · ${BUILD_DATE}`],
    ['Running as', `${isTauri ? 'Desktop app' : 'Browser (dev server)'} on ${platformName()}`],
    ['Targets', 'Classic Diablo II 1.13 / 1.14 (DS1 v1–18, DT1 v7.6)'],
  ];
  return (
    <Modal title="About DS1 Studio" onClose={onClose}>
      <table className="kv small">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td className="muted">{k}</td>
              <td className="mono">{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">
        A modern editor for Diablo II map presets (DS1) and tile libraries (DT1). Diablo II and its data are © Blizzard Entertainment; DS1 Studio reads your
        own game files and never ships them.
      </p>
      <div className="modal-actions">
        <button className="btn" onClick={() => void openExternal(REPO_URL)}>
          GitHub page
        </button>
        <button className="btn" onClick={() => void openExternal(`${REPO_URL}/releases`)}>
          Release notes
        </button>
        <button className="btn primary" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}

type State =
  | { kind: 'checking' }
  | { kind: 'none' }
  | { kind: 'available'; info: UpdateInfo }
  | { kind: 'installing'; info: UpdateInfo; done: number; total: number | null }
  | { kind: 'error'; message: string };

/** Help → Check for updates: finds a newer GitHub release and installs it (or links to it). */
export function UpdateDialog({ onClose, initial }: { onClose: () => void; initial?: UpdateInfo | null }) {
  const [state, setState] = useState<State>(initial ? { kind: 'available', info: initial } : { kind: 'checking' });
  useEffect(() => {
    if (initial) return;
    checkForUpdate()
      .then((info) => setState(info ? { kind: 'available', info } : { kind: 'none' }))
      .catch((e) => setState({ kind: 'error', message: (e as Error).message }));
  }, [initial]);

  const install = async (info: UpdateInfo) => {
    setState({ kind: 'installing', info, done: 0, total: null });
    try {
      await info.install!((done, total) => setState({ kind: 'installing', info, done, total }));
    } catch (e) {
      setState({ kind: 'error', message: `Install failed: ${(e as Error).message}` });
    }
  };

  return (
    <Modal title="Check for updates" onClose={() => state.kind !== 'installing' && onClose()}>
      <p className="small">
        You have <b>{APP_VERSION}</b>.
      </p>
      {state.kind === 'checking' && <p className="muted small">Checking GitHub…</p>}
      {state.kind === 'none' && <p className="small">You&apos;re up to date.</p>}
      {state.kind === 'error' && (
        <p className="small error-text">
          Couldn&apos;t check for updates: {state.message}. You can look at the releases page instead.
        </p>
      )}
      {(state.kind === 'available' || state.kind === 'installing') && (
        <>
          <p className="small">
            Version <b>{state.info.version}</b> is available{state.info.date ? ` (${state.info.date.slice(0, 10)})` : ''}.
          </p>
          {state.info.notes && <pre className="release-notes">{state.info.notes}</pre>}
          {!state.info.install && (
            <p className="muted small">
              {isTauri
                ? 'This install can’t update itself (e.g. installed from a .deb/.rpm package): download the new version from the release page.'
                : 'Download the desktop app from the release page.'}
            </p>
          )}
          {state.kind === 'installing' && (
            <p className="small">
              Downloading… {state.total ? `${Math.round((state.done / state.total) * 100)}%` : `${(state.done / 1048576).toFixed(1)} MB`} — the app restarts
              when it&apos;s installed. Save your map first if you haven&apos;t.
            </p>
          )}
        </>
      )}
      <div className="modal-actions">
        <button className="btn" onClick={() => void openExternal(state.kind === 'available' ? state.info.url : `${REPO_URL}/releases`)}>
          Releases page
        </button>
        {state.kind === 'available' && state.info.install && (
          <button className="btn primary" onClick={() => void install(state.info)}>
            Download and install
          </button>
        )}
        <button className="btn" disabled={state.kind === 'installing'} onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}
