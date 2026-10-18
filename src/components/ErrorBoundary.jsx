import React from 'react';
import { AlertTriangle, RefreshCw, Home } from 'lucide-react';

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('[ErrorBoundary] Erro capturado na interface:', error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
    window.location.reload();
  };

  handleGoHome = () => {
    this.setState({ hasError: false, error: null });
    window.location.href = '/';
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-[50vh] flex items-center justify-center p-6">
          <div className="card max-w-lg w-full p-6 border-red-500/30 bg-panel text-center shadow-glow">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-red-500/10 text-red-400 mb-4 border border-red-500/20 animate-pulse">
              <AlertTriangle className="h-7 w-7" />
            </div>
            <h2 className="text-xl font-bold text-white mb-2">Ops! Ocorreu um erro nesta tela</h2>
            <p className="text-xs text-zinc-400 mb-4">
              Um erro inesperado aconteceu ao renderizar este componente. Você pode recarregar a tela ou voltar para a Mesa Operacional.
            </p>
            {this.state.error?.message && (
              <div className="rounded-lg bg-panel2 border border-line p-3 text-left font-mono text-[11px] text-red-300 mb-5 max-h-32 overflow-auto">
                {this.state.error.message}
              </div>
            )}
            <div className="flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                onClick={this.handleReset}
                className="btn-primary flex items-center gap-2 text-xs"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Recarregar tela
              </button>
              <button
                type="button"
                onClick={this.handleGoHome}
                className="btn-ghost flex items-center gap-2 text-xs"
              >
                <Home className="h-3.5 w-3.5" />
                Mesa Operacional
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
