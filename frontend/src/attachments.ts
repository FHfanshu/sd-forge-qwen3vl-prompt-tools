import type { ChatAttachment } from "./contracts";

export const MAX_ATTACHMENTS = 8;
export const MAX_SOURCE_IMAGE_BYTES = 24 * 1024 * 1024;
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 16 * 1024 * 1024;
export const MAX_IMAGE_EDGE = 1536;
const REENCODE_THRESHOLD_BYTES = 2 * 1024 * 1024;

function readBlobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read image data"));
    reader.readAsDataURL(blob);
  });
}

async function decodeImage(file: File): Promise<{ source: CanvasImageSource; width: number; height: number; close(): void } | null> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch {
      return null;
    }
  }
  if (typeof Image === "undefined" || typeof URL?.createObjectURL !== "function") return null;
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const candidate = new Image();
      candidate.onload = () => resolve(candidate);
      candidate.onerror = () => reject(new Error(`Could not decode ${file.name}`));
      candidate.src = objectUrl;
    });
    return { source: image, width: image.naturalWidth, height: image.naturalHeight, close: () => URL.revokeObjectURL(objectUrl) };
  } catch {
    URL.revokeObjectURL(objectUrl);
    return null;
  }
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.88));
}

async function optimizedBlob(file: File): Promise<Blob> {
  const decoded = await decodeImage(file);
  if (!decoded) return file;
  try {
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(decoded.width, decoded.height));
    if (scale === 1 && file.size <= REENCODE_THRESHOLD_BYTES) return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(decoded.width * scale));
    canvas.height = Math.max(1, Math.round(decoded.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return file;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(decoded.source, 0, 0, canvas.width, canvas.height);
    const encoded = await canvasBlob(canvas);
    return encoded && encoded.size < file.size ? encoded : file;
  } finally {
    decoded.close();
  }
}

export function attachmentByteSize(attachment: ChatAttachment): number {
  if (Number.isFinite(attachment.size)) return Number(attachment.size);
  const encoded = attachment.dataUrl.split(",", 2)[1] ?? "";
  return Math.max(0, Math.floor(encoded.length * 0.75));
}

export function totalAttachmentBytes(attachments: ChatAttachment[]): number {
  return attachments.reduce((total, attachment) => total + attachmentByteSize(attachment), 0);
}

export async function createImageAttachment(file: File, attachmentId: string): Promise<ChatAttachment> {
  if (!file.type.startsWith("image/")) throw new Error("Only image files can be attached.");
  if (file.size > MAX_SOURCE_IMAGE_BYTES) throw new Error(`${file.name} is larger than 24 MB.`);
  const blob = await optimizedBlob(file);
  if (blob.size > MAX_ATTACHMENT_BYTES) throw new Error(`${file.name} is still larger than 8 MB after optimization.`);
  return {
    id: attachmentId,
    name: file.name,
    dataUrl: await readBlobAsDataUrl(blob),
    mimeType: blob.type || file.type,
    size: blob.size,
  };
}

export function assertAttachmentTotal(attachments: ChatAttachment[]): void {
  if (totalAttachmentBytes(attachments) > MAX_TOTAL_ATTACHMENT_BYTES) {
    throw new Error("Attached images exceed the 16 MB total limit.");
  }
}
