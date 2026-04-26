import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { Toaster } from "sonner";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./styles/globals.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ErrorBoundary>
    <Toaster
      position="top-center"
      theme="dark"
      toastOptions={{
        style: {
          background: "var(--bg-raised)",
          border: "1px solid var(--border-subtle)",
          color: "var(--text-primary)",
          fontFamily: "var(--font-body)",
        },
        className: "tabular",
      }}
    />
  </StrictMode>,
);
