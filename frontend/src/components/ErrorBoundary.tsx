import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null; info: ErrorInfo | null };

/**
 * Last-resort UI when a render exception escapes a child. Without this,
 * a single bad selector or an unhandled component error gives the user
 * an unstyled blank `#root` and the only way to diagnose is the dev
 * server log. With it, errors stop at the boundary and the user sees a
 * recoverable state with a "Reload" affordance.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ info });
    // eslint-disable-next-line no-console
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  private handleReload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div
        role="alert"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "1rem",
          minHeight: "100vh",
          padding: "3rem 2rem",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--bg-base, #0a0d12)",
          color: "var(--text-primary, #e6edf3)",
          fontFamily: "var(--font-body, system-ui)",
          textAlign: "center",
        }}
      >
        <h1 style={{ margin: 0, fontSize: "1.5rem", letterSpacing: "-0.01em" }}>
          Something rendered itself off the canvas.
        </h1>
        <p style={{ margin: 0, opacity: 0.72, maxWidth: "42ch" }}>
          {this.state.error.message}
        </p>
        <button
          onClick={this.handleReload}
          style={{
            padding: "0.6rem 1.2rem",
            border: "1px solid var(--border-default, #1f2937)",
            borderRadius: "8px",
            background: "var(--bg-raised, #111827)",
            color: "inherit",
            fontFamily: "inherit",
            cursor: "pointer",
          }}
        >
          Reload
        </button>
        {import.meta.env.DEV && this.state.info && (
          <details style={{ maxWidth: "60ch", marginTop: "1rem", opacity: 0.6 }}>
            <summary style={{ cursor: "pointer" }}>Component stack</summary>
            <pre
              style={{
                textAlign: "left",
                fontFamily: "ui-monospace, monospace",
                fontSize: "0.75rem",
                whiteSpace: "pre-wrap",
                marginTop: "0.5rem",
              }}
            >
              {this.state.info.componentStack}
            </pre>
          </details>
        )}
      </div>
    );
  }
}

export default ErrorBoundary;
