// downloadFile.ts
//
// Programmatic file save: build a Blob, hand it to the browser via an
// invisible <a download="…"> element. Revokes the object URL on next
// frame so we don't leak.

export function downloadFile(
  filename: string,
  content: string | Blob,
  mime = "text/markdown;charset=utf-8",
): void {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  // Some browsers (and jsdom) only honor click() on attached nodes.
  document.body.appendChild(a);
  a.click();
  // Detach + revoke. Defer revoke a tick so Safari finishes the download.
  document.body.removeChild(a);
  // setTimeout(0) keeps tests deterministic in jsdom.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export default downloadFile;
