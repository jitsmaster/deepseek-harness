/**
 * Image preparation for a headless `claude -p` run: durable image references are
 * resolved to bounded base64 bytes that go into the stdin message as image blocks.
 * @module @deepseek-ai/dsh-llm-claude-code/images
 */

import type { AttachmentStore, ImageAttachmentRef, ImageRequestTarget } from '@deepseek-ai/dsh-attachment'
import { contentHasImage, offloadedImageText, projectOffloadedImages } from '@deepseek-ai/dsh-llm'
import type { RequestMessage } from '@deepseek-ai/dsh-llm'
import type { ImageLookup, RequestImage } from './transcript.ts'

/** Long edge Claude resizes to anyway; sending more pixels only costs bytes. */
export const MAX_IMAGE_LONG_EDGE = 1568

/** Encoded bytes allowed per image before base64 (the API refuses base64 over 5 MB). */
export const MAX_IMAGE_BYTES = 3_500_000

/**
 * The size an image is sent at: its own size, scaled down to the long-edge bound.
 * @param ref - normalized image reference.
 * @returns the target handed to the attachment service and reported to the UI.
 */
export function imageTarget(ref: Pick<ImageAttachmentRef, 'width' | 'height'>): ImageRequestTarget {
  const longEdge = Math.max(ref.width, ref.height)
  const scale = longEdge > MAX_IMAGE_LONG_EDGE ? MAX_IMAGE_LONG_EDGE / longEdge : 1
  return {
    width: Math.max(1, Math.round(ref.width * scale)),
    height: Math.max(1, Math.round(ref.height * scale)),
    maxBytes: MAX_IMAGE_BYTES,
  }
}

/** The result of preparing one request's images. */
export interface PreparedImages {
  /** The messages with offloaded images replaced by their placeholder text. */
  messages: readonly RequestMessage[]
  /** Resolves a retained image reference to its bytes; undefined renders placeholder text. */
  lookup: ImageLookup | undefined
}

/**
 * Resolve every retained image of the request to base64 bytes.
 * @param messages - the request messages.
 * @param attachments - the durable attachment service; images need it.
 * @param signal - request cancellation.
 * @returns the projected messages and the lookup; no lookup when the request has no image.
 * @throws when an image is present and no attachment service is mounted, or a read fails.
 */
export async function prepareImages(
  messages: readonly RequestMessage[],
  attachments: AttachmentStore | undefined,
  signal: AbortSignal,
): Promise<PreparedImages> {
  const projected = projectOffloadedImages(messages, ref => offloadedImageText(ref))
  if (!projected.some(message => contentHasImage(message.content))) return { messages: projected, lookup: undefined }
  if (attachments === undefined) throw new Error('image input requires the durable attachment service')
  const refs = new Map<string, ImageAttachmentRef>()
  for (const message of projected) {
    for (const block of message.content) {
      if (block.type === 'image') refs.set(String(block.attachment.attachmentId), block.attachment)
    }
  }
  const resolved = new Map<string, RequestImage>()
  await Promise.all([...refs].map(async ([id, ref]) => {
    const version = await attachments.readImageRequest(ref, imageTarget(ref), signal)
    resolved.set(id, { mediaType: version.mediaType, data: Buffer.from(version.data).toString('base64') })
  }))
  return { messages: projected, lookup: ref => resolved.get(String(ref.attachmentId)) }
}
