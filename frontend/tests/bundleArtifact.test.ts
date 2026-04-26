import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { bundleArtifact } from "../src/lib/bundleArtifact";

// jsdom's Blob doesn't implement arrayBuffer; use FileReader as a portable
// shim, then hand the binary string to JSZip.
function blobToBinaryString(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsBinaryString(blob);
  });
}

async function loadZip(blob: Blob): Promise<JSZip> {
  const bin = await blobToBinaryString(blob);
  return await JSZip.loadAsync(bin, { binary: true } as never);
}

async function entryNames(blob: Blob): Promise<string[]> {
  const zip = await loadZip(blob);
  return Object.keys(zip.files).sort();
}

async function entryContent(blob: Blob, path: string): Promise<string | null> {
  const zip = await loadZip(blob);
  const f = zip.file(path);
  return f ? await f.async("string") : null;
}

describe("bundleArtifact", () => {
  it("packs each provided file into the zip", async () => {
    const blob = await bundleArtifact({
      markdown: "# Primary",
      files: [
        { path: "README.md", content: "# Hello" },
        { path: "architecture.md", content: "## Arch" },
        { path: "routes.md", content: "## Routes" },
      ],
    });
    const names = await entryNames(blob);
    expect(names).toContain("README.md");
    expect(names).toContain("architecture.md");
    expect(names).toContain("routes.md");
  });

  it("uses the provided README.md when present (does not duplicate)", async () => {
    const blob = await bundleArtifact({
      markdown: "# Primary",
      files: [{ path: "README.md", content: "# Existing" }],
    });
    const readme = await entryContent(blob, "README.md");
    expect(readme).toBe("# Existing");
    // Only one README entry total.
    const names = await entryNames(blob);
    expect(names.filter((n) => n.toLowerCase() === "readme.md")).toHaveLength(1);
  });

  it("falls back to primary markdown as README.md when none provided", async () => {
    const blob = await bundleArtifact({
      markdown: "# Generated",
      files: [{ path: "architecture.md", content: "x" }],
    });
    const readme = await entryContent(blob, "README.md");
    expect(readme).toBe("# Generated");
    const arch = await entryContent(blob, "architecture.md");
    expect(arch).toBe("x");
  });

  it("works with no extra files (single README from primary markdown)", async () => {
    const blob = await bundleArtifact({ markdown: "# Solo" });
    const names = await entryNames(blob);
    expect(names).toEqual(["README.md"]);
    expect(await entryContent(blob, "README.md")).toBe("# Solo");
  });

  it("returns a Blob", async () => {
    const blob = await bundleArtifact({ markdown: "# x" });
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.size).toBeGreaterThan(0);
  });
});
