import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import type { GeneratedImage } from "@/components/canvas/image-node-model";

type Size = { width: number; height: number };
/** Decode media metadata for uploads, library inserts and restored/collaborative nodes alike. */
export function useImageDimensions(images: GeneratedImage[], setImages: Dispatch<SetStateAction<GeneratedImage[]>>, read: (url: string) => Promise<Size>) {
  const cache = useRef(new Map<string, {url: string; size: Promise<Size>}>());
  useEffect(() => {
    let alive = true;
    const pending = images.filter(image => !image.pending && image.dataUrl).map(async image => {
      const key = image.path || image.id;
      let entry = cache.current.get(key);
      if (!entry || entry.url !== image.dataUrl) {
        entry = {url: image.dataUrl, size: read(image.dataUrl).catch(() => ({width: 0, height: 0}))};
        cache.current.set(key, entry);
      }
      return {id: image.id, path: image.path, url: image.dataUrl, ...await entry.size};
    });
    void Promise.all(pending).then(sizes => {
      if (!alive) return;
      const byId = new Map(sizes.filter(size => size.width > 0 && size.height > 0).map(size => [size.id, size]));
      setImages(current => {
        let changed = false;
        const next = current.map(image => {
          const size = byId.get(image.id);
          if (!size || image.pending || image.path !== size.path || image.dataUrl !== size.url || (image.width === size.width && image.height === size.height)) return image;
          changed = true;
          return {...image, width: size.width, height: size.height, versions: image.versions?.map(version => version.path === image.path ? {...version, width: size.width, height: size.height} : version)};
        });
        return changed ? next : current;
      });
    });
    return () => {alive = false;};
  }, [images, setImages, read]);
}
