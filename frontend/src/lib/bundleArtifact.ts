// bundleArtifact.ts
//
// Pack an artifact (primary markdown + extra files) into a single zip Blob.
// For `scaffold` artifacts the extra files are the project skeleton
// (architecture.md, routes.md, etc); the primary markdown becomes README.md
// unless an explicit README.md is already present in the file list.

import JSZip from "jszip";

export type BundleInput = {
  markdown: string;
  files?: { path: string; content: string }[];
};

export async function bundleArtifact(artifact: BundleInput): Promise<Blob> {
  const zip = new JSZip();
  const files = artifact.files ?? [];

  let hasReadme = false;
  for (const f of files) {
    if (!f || !f.path) continue;
    if (f.path.toLowerCase() === "readme.md") {
      hasReadme = true;
    }
    zip.file(f.path, f.content ?? "");
  }

  if (!hasReadme) {
    zip.file("README.md", artifact.markdown ?? "");
  }

  return await zip.generateAsync({ type: "blob" });
}

export default bundleArtifact;
