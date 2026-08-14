import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ServerErrorPage, type ServerErrorDevDetails } from '../../pages/system/ServerErrorPage';

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  hasError: boolean;
  /** CORE-REALTEST-BLOCKER-01B — passed on, but only shown in the dev build. */
  devDetails: ServerErrorDevDetails | null;
}

function readMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return 'Unbekannter Fehler';
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { hasError: false, devDetails: null };

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    return {
      hasError: true,
      devDetails: {
        message: readMessage(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The component stack is only available here, not in getDerivedStateFromError.
    this.setState((previous) => ({
      hasError: true,
      devDetails: {
        message: previous.devDetails?.message ?? readMessage(error),
        stack: previous.devDetails?.stack ?? error.stack,
        componentStack: info.componentStack ?? undefined,
      },
    }));
    if (import.meta.env.DEV) {
      console.error('[OfficePilot] Unbehandelter UI-Fehler:', error, info);
    }
  }

  private handleRetry = (): void => {
    this.setState({ hasError: false, devDetails: null });
    window.location.assign('/');
  };

  render() {
    if (this.state.hasError) {
      return <ServerErrorPage onRetry={this.handleRetry} devDetails={this.state.devDetails} />;
    }
    return this.props.children;
  }
}
