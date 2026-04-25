import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useCallback, useEffect, useState } from "react";
import { ImagePlus } from "lucide-react";
import { useGraphStore } from "@/state/graphStore";
import { toast } from "sonner";

/**
 * App-wide drag/drop overlay. While the user is dragging an image, the
 * whole app dims and a glowing dropzone fades in. On drop, the image is
 * uploaded to Cloudinary (unsigned preset), then PATCHed onto the
 * currently selected node.
 */
export function ImageDropZone() {
  const [dragging, setDragging] = useState(false);
  const reduceMotion = useReducedMotion();
  const selectedNodeId = useGraphStore((s) => s.selectedNodeId);

  const cloudName = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME;
  const preset = import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET;

  useEffect(() => {
    let depth = 0;
    const onEnter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      depth += 1;
      setDragging(true);
    };
    const onLeave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onOver = (e: DragEvent) => {
      e.preventDefault();
    };
    const onDrop = () => {
      depth = 0;
      setDragging(false);
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragging(false);
      if (!selectedNodeId) {
        toast("Select a node before dropping an image");
        return;
      }
      const file = e.dataTransfer.files?.[0];
      if (!file || !file.type.startsWith("image/")) {
        toast("Only image files are supported");
        return;
      }
      if (!cloudName || !preset) {
        toast("Cloudinary not configured");
        return;
      }
      try {
        const fd = new FormData();
        fd.append("file", file);
        fd.append("upload_preset", preset);
        const res = await fetch(
          `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
          { method: "POST", body: fd },
        );
        if (!res.ok) throw new Error(`upload status ${res.status}`);
        const json = (await res.json()) as { secure_url: string };
        await fetch(
          `${import.meta.env.VITE_BACKEND_URL ?? ""}/nodes/${selectedNodeId}/image`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ image_url: json.secure_url }),
          },
        );
        useGraphStore.setState((s) => {
          const n = s.nodes[selectedNodeId];
          if (!n) return {};
          return {
            nodes: { ...s.nodes, [selectedNodeId]: { ...n, image_url: json.secure_url } },
          };
        });
        toast("Image attached");
      } catch (err) {
        toast("Upload failed", { description: String(err) });
      }
    },
    [selectedNodeId, cloudName, preset],
  );

  return (
    <AnimatePresence>
      {dragging ? (
        <motion.div
          className="dropzone-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={reduceMotion ? { duration: 0 } : { duration: 0.18 }}
          onDrop={handleDrop}
          onDragOver={(e) => e.preventDefault()}
        >
          <motion.div
            className="dropzone-card"
            initial={reduceMotion ? false : { scale: 0.96, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 240, damping: 22 }}
          >
            <ImagePlus size={28} />
            <h3>Drop an image</h3>
            <p>
              {selectedNodeId
                ? "Image will be attached to the selected node."
                : "Select a node first."}
            </p>
          </motion.div>

          <style>{`
            .dropzone-overlay {
              position: fixed;
              inset: 0;
              z-index: var(--z-overlay);
              background: rgba(7, 11, 20, 0.7);
              backdrop-filter: blur(10px);
              display: grid;
              place-items: center;
            }
            .dropzone-card {
              width: min(420px, 80vw);
              padding: var(--space-10);
              border-radius: var(--radius-xl);
              background: var(--bg-raised);
              border: 2px dashed var(--signature-accent);
              box-shadow: 0 0 64px var(--signature-accent-glow), var(--elev-3);
              text-align: center;
              color: var(--text-primary);
            }
            .dropzone-card h3 {
              margin: var(--space-3) 0 var(--space-1);
              font-family: var(--font-display);
            }
            .dropzone-card p {
              color: var(--text-secondary);
              font-size: var(--font-size-sm);
            }
          `}</style>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

export default ImageDropZone;
