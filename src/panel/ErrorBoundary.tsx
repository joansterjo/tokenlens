import { Component, Fragment, useState, useSyncExternalStore } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { emitCSS, serializeSession } from '../core/emit';
import { VERSION } from '../shared/version';
import type { PanelStore } from './store';
import './recovery.css';

interface Props {
  children: ReactNode;
  store: PanelStore;
  onRetry?: () => void;
}

interface State {
  failed: boolean;
  error: unknown;
  componentStack: string;
  attempt: number;
}

function readableError(error: unknown): string {
  let message = 'An unexpected error interrupted the editor.';
  if (error instanceof Error) message = `${error.name}: ${error.message}`;
  else if (typeof error === 'string') message = error;
  // Show useful diagnostics without putting page or extension URLs in the UI.
  return message.replace(/(?:[a-z][a-z\d+.-]*:\/\/|data:|blob:)[^\s<>'"()]+/gi, '[URL omitted]').slice(0, 2000);
}

function download(text: string, type: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Recovery({ store, error, componentStack, retry }: Omit<Props, 'children' | 'onRetry'> & { error: unknown; componentStack: string; retry: () => void }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [exportError, setExportError] = useState('');
  const count = Array.isArray(snapshot.edits) ? snapshot.edits.length : 0;
  const save = (format: 'css' | 'json') => {
    try {
      const edits = store.getSnapshot().edits;
      const options = { generatedAt: new Date().toISOString() };
      if (format === 'json') download(serializeSession(edits, options), 'application/json', 'tokenlens-recovery-session.json');
      else download(emitCSS(edits, { ...options, target: 'stylus' }), 'text/css', 'tokenlens-recovery-overrides.css');
      setExportError('');
    } catch (cause) {
      console.error(`TokenLens recovery ${format} export failed`, cause);
      setExportError(`Could not save ${format.toUpperCase()}. ${readableError(cause)}`);
    }
  };
  return <main className="panel-recovery">
    <section className="panel-recovery-card" aria-labelledby="recovery-title">
      <header><span className="logo-mark" aria-hidden="true"><i/><i/><i/><i/></span><strong>tokenlens</strong><span>v{VERSION}</span></header>
      <div className="panel-recovery-message" role="alert"><p className="panel-recovery-eyebrow">EDITOR RECOVERY</p><h1 id="recovery-title">The editor hit a problem.</h1><p>TokenLens could not display this view. Your session has not been reset.</p></div>
      <p className="panel-recovery-edits">{count ? <><strong>{count} {count === 1 ? 'edit is' : 'edits are'} still in this session.</strong> Save a backup before closing DevTools or reloading the page.</> : 'Retry the editor, then pick an element again. If the problem continues, use the details below to report it.'}</p>
      <div className="panel-recovery-actions"><button className="primary-button" onClick={retry}>Retry editor</button><button className="secondary-button" disabled={!count} onClick={() => save('json')}>Save session JSON</button><button className="secondary-button" disabled={!count} onClick={() => save('css')}>Save CSS</button></div>
      {count > 0 && <p className="panel-recovery-note">The JSON backup includes all edits. CSS export keeps its usual warnings for edits that cannot be reproduced in a stylesheet.</p>}
      {exportError && <p className="panel-recovery-export-error" role="alert">{exportError}</p>}
      <details><summary>Error details</summary><p>URLs are omitted here. The original error is also available in this panel’s console.</p><pre>{readableError(error)}{componentStack ? `\n\nComponent trace:${readableError(componentStack)}` : ''}</pre></details>
      <footer><a href="https://github.com/joansterjo/tokenlens/issues" target="_blank" rel="noreferrer">Report this issue</a><span>Built by Joan Sterjo</span></footer>
    </section>
  </main>;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false, error: null, componentStack: '', attempt: 0 };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { failed: true, error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('TokenLens editor failed', error, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? '' });
  }

  private retry = () => {
    try {
      this.props.onRetry?.();
      this.setState(state => ({ failed: false, error: null, componentStack: '', attempt: state.attempt + 1 }));
    } catch (error) {
      console.error('TokenLens editor retry failed', error);
      this.setState({ failed: true, error, componentStack: '' });
    }
  };

  render() {
    return this.state.failed
      ? <Recovery store={this.props.store} error={this.state.error} componentStack={this.state.componentStack} retry={this.retry}/>
      : <Fragment key={this.state.attempt}>{this.props.children}</Fragment>;
  }
}
