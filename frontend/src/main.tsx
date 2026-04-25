import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import App from "./App";
import "./styles/globals.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
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
