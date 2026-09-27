import { Component, type ErrorInfo, type ReactNode } from 'react';
import { bugReportUrl, openExternal } from '../app/updates';

interface Props {
  children: ReactNode;
  /** Where this boundary sits, for the message ("the map view", "DS1 Studio"). */
  what: string;
  /** Extra context for the bug report (e.g. the open map). */
  context?: () => { map?: string | null };
  /** Something to offer besides "Try again" (e.g. close the map). */
  action?: { label: string; onClick: () => void };
  /** Changing this clears the error (e.g. a different map was opened). */
  resetKey?: unknown;
  compact?: boolean;
}

interface State {
  error: Error | null;
  stack: string;
}

/**
 * Catches errors while drawing part of the app, so a failure shows what happened (with a way to report it) instead of
 * a blank window.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: '' };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ stack: `${error.stack ?? error.message}\n\nComponent stack:${info.componentStack ?? ''}`.slice(0, 4000) });
    console.error(error, info.componentStack);
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null, stack: '' });
  }

  render() {
    const { error, stack } = this.state;
    if (!error) return this.props.children;
    const report = () => {
      const url = new URL(bugReportUrl({ ...(this.props.context?.() ?? {}), title: `[Bug] ${this.props.what} stopped: ${error.message}`.slice(0, 120) }));
      const body = url.searchParams.get('body') ?? '';
      // Keep the link a sensible length: the start of the stack is what matters.
      url.searchParams.set('body', `${body}\n\n### Error\n\`\`\`\n${stack.slice(0, 2500)}\n\`\`\``);
      void openExternal(url.toString());
    };
    return (
      <div className={`crash${this.props.compact ? ' compact' : ''}`} role="alert">
        <div className="crash-title">Something went wrong in {this.props.what}.</div>
        <div className="crash-message mono">{error.message}</div>
        <p className="muted small">Your unsaved changes are kept in the autosave. Try again, or report it so it can be fixed (the details below are included).</p>
        <div className="crash-actions">
          <button className="btn primary" onClick={() => this.setState({ error: null, stack: '' })}>
            Try again
          </button>
          {this.props.action && (
            <button className="btn" onClick={this.props.action.onClick}>
              {this.props.action.label}
            </button>
          )}
          <button className="btn" onClick={report}>
            Report this bug
          </button>
          <button className="btn" onClick={() => window.location.reload()}>
            Reload DS1 Studio
          </button>
        </div>
        <details>
          <summary className="small muted">Details</summary>
          <pre className="crash-stack">{stack || error.stack}</pre>
        </details>
      </div>
    );
  }
}
