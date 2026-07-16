import { describe, expect, it } from "vitest";
import {
  assertAttachmentTotal,
  attachmentByteSize,
  createImageAttachment,
  MAX_SOURCE_IMAGE_BYTES,
} from "../src/attachments";

describe("reference image preparation", () => {
  it("keeps small image payloads compatible when decoding is unavailable", async () => {
    const file = new File([new Uint8Array([1, 2, 3, 4])], "reference.png", { type: "image/png" });
    const attachment = await createImageAttachment(file, "attachment-1");
    expect(attachment).toMatchObject({ id: "attachment-1", name: "reference.png", mimeType: "image/png", size: 4 });
    expect(attachment.dataUrl).toMatch(/^data:image\/png;base64,/);
  });

  it("rejects source images above the browser-side safety limit", async () => {
    const file = new File([new Uint8Array(MAX_SOURCE_IMAGE_BYTES + 1)], "huge.png", { type: "image/png" });
    await expect(createImageAttachment(file, "attachment-2")).rejects.toThrow(/24 MB/);
  });

  it("enforces a combined encoded payload budget", () => {
    const large = { id: "large", name: "large.png", dataUrl: "data:image/png;base64,", size: 17 * 1024 * 1024 };
    expect(attachmentByteSize(large)).toBe(17 * 1024 * 1024);
    expect(() => assertAttachmentTotal([large])).toThrow(/16 MB/);
  });
});
