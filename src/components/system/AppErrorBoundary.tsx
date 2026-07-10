import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ServerErrorPage } from '../../pages/system/ServerErrorPage';

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  hasError: boolean;
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    if (import.meta.env.DEV) {
      console.error('[OfficePilot] Unbehandelter UI-Fehler:', error, info);
    }
  }

  private handleRetry = (): void => {
    this.setState({ hasError: false });
    window.location.assign('/');
  };

  render() {
    if (this.state.hasError) {
      return <ServerErrorPage onRetry={this.handleRetry} />;
    }
    return this.props.children;
  }
}
