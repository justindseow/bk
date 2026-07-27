const toHex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')

export const buildFileFingerprint = async (file: File) => {
  const head = await file.slice(0, 65536).arrayBuffer()
  const descriptor = new TextEncoder().encode(`${file.name.toLowerCase()}|${file.size}|${file.lastModified}|${file.type}`)

  if (globalThis.crypto?.subtle) {
    const merged = new Uint8Array(descriptor.byteLength + head.byteLength)
    merged.set(descriptor, 0)
    merged.set(new Uint8Array(head), descriptor.byteLength)
    const digest = await globalThis.crypto.subtle.digest('SHA-256', merged)
    return toHex(digest)
  }

  return `${file.name.toLowerCase()}|${file.size}|${file.lastModified}|${file.type}`
}
