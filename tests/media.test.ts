import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decryptMedia, encryptMedia, extractFileDirectives, paddedSize, resolveWorkspaceFile, safeFileName } from '../src/media.js'

describe('Weixin media helpers', () => {
  it('round trips AES-128-ECB media with both observed key encodings', () => {
    const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
    const plaintext = Buffer.from('hello image')
    const encrypted = encryptMedia(plaintext, key)
    expect(encrypted).toHaveLength(paddedSize(plaintext.length))
    expect(decryptMedia(encrypted, key.toString('base64'))).toEqual(plaintext)
    expect(decryptMedia(encrypted, Buffer.from(key.toString('hex')).toString('base64'))).toEqual(plaintext)
  })

  it('sanitizes inbound names and only recognizes explicit outbound directives', () => {
    expect(safeFileName('../../weird?.pdf', 'file.bin')).toBe('weird_.pdf')
    expect(extractFileDirectives('Done\n\n[[send-file: reports/out.pdf]]\n')).toEqual({ text: 'Done', files: ['reports/out.pdf'] })
    expect(extractFileDirectives('[ordinary](reports/out.pdf)')).toEqual({ text: '[ordinary](reports/out.pdf)', files: [] })
  })

  it('allows regular workspace files and rejects paths outside the workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-weixin-media-'))
    const outside = await mkdtemp(join(tmpdir(), 'dsh-weixin-outside-'))
    await mkdir(join(root, 'reports'))
    await writeFile(join(root, 'reports', 'ok.pdf'), 'pdf')
    await writeFile(join(outside, 'secret.txt'), 'secret')
    await expect(resolveWorkspaceFile(root, 'reports/ok.pdf', 10)).resolves.toMatchObject({ name: 'ok.pdf' })
    await expect(resolveWorkspaceFile(root, join(outside, 'secret.txt'), 10)).rejects.toThrow('inside the configured workspace')
  })
})
