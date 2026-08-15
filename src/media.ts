/** Weixin CDN media encryption, download, upload, and safe local-file helpers. */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdir, open, readFile, realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export type MediaKind = 'image' | 'voice' | 'file' | 'video'

export interface InboundMedia {
  kind: MediaKind
  name: string
  mediaType: string
  data: Uint8Array
}

export interface CdnMediaRef {
  encrypt_query_param?: string
  aes_key?: string
  full_url?: string
}

export interface WireMediaItem {
  type?: number
  image_item?: { media?: CdnMediaRef; aeskey?: string }
  voice_item?: { media?: CdnMediaRef; text?: string }
  file_item?: { media?: CdnMediaRef; file_name?: string }
  video_item?: { media?: CdnMediaRef }
}

const MEDIA_TYPES: Record<MediaKind, number> = { image: 1, video: 2, file: 3, voice: 4 }
const MIME_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.txt': 'text/plain', '.json': 'application/json',
  '.zip': 'application/zip', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}
const DEFAULT_MEDIA_TYPES: Readonly<Record<MediaKind, string>> = {
  image: 'application/octet-stream',
  video: 'video/mp4',
  voice: 'audio/silk',
  file: 'application/octet-stream',
}

export function uploadMediaType(kind: MediaKind): number {
  return MEDIA_TYPES[kind]
}

export function paddedSize(size: number): number {
  return Math.ceil((size + 1) / 16) * 16
}

export function encryptMedia(data: Uint8Array, key: Uint8Array): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(data), cipher.final()])
}

export function decryptMedia(data: Uint8Array, encodedKey: string): Buffer {
  const decoded = Buffer.from(encodedKey, 'base64')
  const key = decoded.length === 16
    ? decoded
    : decoded.length === 32 && /^[0-9a-f]{32}$/i.test(decoded.toString('ascii'))
      ? Buffer.from(decoded.toString('ascii'), 'hex')
      : undefined
  if (key === undefined) throw new Error('Weixin media AES key is invalid')
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  return Buffer.concat([decipher.update(data), decipher.final()])
}

export function mediaTypeForName(name: string, kind: MediaKind): string {
  const extension = extname(name).toLowerCase()
  return MIME_TYPES[extension] ?? DEFAULT_MEDIA_TYPES[kind]
}

export function safeFileName(input: string, fallback: string): string {
  const cleaned = basename(input).replace(/[\u0000-\u001f\u007f]/g, '').replace(/[^\p{L}\p{N}._ -]/gu, '_').trim()
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? fallback : cleaned.slice(0, 180)
}

export async function saveInboundMedia(root: string, chatKey: string, media: InboundMedia): Promise<string> {
  const directory = join(root, createHash('sha256').update(chatKey).digest('hex').slice(0, 16))
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const name = `${Date.now()}-${randomBytes(6).toString('hex')}-${safeFileName(media.name, `${media.kind}.bin`)}`
  const path = join(directory, name)
  const file = await open(path, 'wx', 0o600)
  try {
    await file.writeFile(media.data)
    await file.sync()
  } finally {
    await file.close()
  }
  return path
}

/** Resolve an agent-requested file and prove it remains inside the configured workspace. */
export async function resolveWorkspaceFile(workspace: string, requested: string, maxBytes: number): Promise<{ path: string; name: string; bytes: Buffer }> {
  const candidate = resolve(workspace, requested)
  const workspaceReal = await realpath(workspace)
  const candidateReal = await realpath(candidate)
  const inside = relative(workspaceReal, candidateReal)
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error('outbound file must be inside the configured workspace')
  const metadata = await stat(candidateReal)
  if (!metadata.isFile()) throw new Error('outbound attachment is not a regular file')
  if (metadata.size > maxBytes) throw new Error(`outbound attachment exceeds ${maxBytes} bytes`)
  return { path: candidateReal, name: safeFileName(candidateReal, 'file.bin'), bytes: await readFile(candidateReal) }
}

export function classifyOutbound(name: string): MediaKind {
  const mime = mediaTypeForName(name, 'file')
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  return 'file'
}

/** Extract explicit file-send directives without treating ordinary Markdown links as exfiltration requests. */
export function extractFileDirectives(text: string): { text: string; files: string[] } {
  const files: string[] = []
  const output = text.replace(/^\s*\[\[send-file:(.+?)\]\]\s*$/gmu, (_match, path: string) => {
    const trimmed = path.trim()
    if (trimmed !== '') files.push(trimmed)
    return ''
  }).replace(/\n{3,}/g, '\n\n').trim()
  return { text: output, files }
}
