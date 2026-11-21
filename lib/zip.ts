import { crc32, inflateRawSync } from 'node:zlib'

// Takes one file out of a zip archive, such as a GitHub Actions artifact.
// Pure: it only computes. It reads stored and deflated entries. It refuses
// ZIP64 and encryption, which an artifact of a few small files never uses.

export const MAX_ENTRY_BYTES = 1024 * 1024

const END_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const END_SIZE = 22
const CENTRAL_SIZE = 46
const LOCAL_SIZE = 30
const MAX_COMMENT = 0xffff
const ZIP64_COUNT = 0xffff
const ZIP64_NUMBER = 0xffffffff
const ENCRYPTED = 0x1
const STORED = 0
const DEFLATED = 8

// tooLarge is true for an entry over MAX_ENTRY_BYTES, and false for an archive the reader cannot read.
export class ZipRefused extends Error {
  tooLarge: boolean

  constructor(message: string, { tooLarge = false }: { tooLarge?: boolean } = {}) {
    super(message)
    this.name = 'ZipRefused'
    this.tooLarge = tooLarge
  }
}

interface Directory {
  count: number
  offset: number
  end: number
}

interface CentralHeader {
  flags: number
  method: number
  crc: number
  compressedSize: number
  size: number
  localOffset: number
  name: Uint8Array
  next: number
}

function directoryAt(view: DataView, position: number): Directory {
  const diskCount = view.getUint16(position + 8, true)
  const count = view.getUint16(position + 10, true)
  const size = view.getUint32(position + 12, true)
  const offset = view.getUint32(position + 16, true)

  if (diskCount === ZIP64_COUNT || count === ZIP64_COUNT || size === ZIP64_NUMBER || offset === ZIP64_NUMBER) {
    throw new ZipRefused('the archive uses ZIP64')
  }

  if (offset + size > position) {
    throw new ZipRefused('the central directory runs past its end record')
  }

  return { count, offset, end: offset + size }
}

// The record sits at the end, after a comment of up to 65535 bytes.
function directory(view: DataView): Directory {
  const last = view.byteLength - END_SIZE
  const first = Math.max(0, last - MAX_COMMENT)

  for (let position = last; position >= first; position -= 1) {
    if (view.getUint32(position, true) === END_SIGNATURE) {
      return directoryAt(view, position)
    }
  }

  throw new ZipRefused('no end of central directory record')
}

// The sizes and the CRC-32 come from here, because a zip written as a stream
// sets flag bit 3 and leaves zeros in the local header.
function centralHeader(view: DataView, archive: Uint8Array, position: number, end: number): CentralHeader {
  if (position + CENTRAL_SIZE > end || view.getUint32(position, true) !== CENTRAL_SIGNATURE) {
    throw new ZipRefused('a central directory header is missing or damaged')
  }

  const nameLength = view.getUint16(position + 28, true)
  const extraLength = view.getUint16(position + 30, true)
  const commentLength = view.getUint16(position + 32, true)
  const next = position + CENTRAL_SIZE + nameLength + extraLength + commentLength

  if (next > end) {
    throw new ZipRefused('a central directory header runs past the directory')
  }

  return {
    flags: view.getUint16(position + 8, true),
    method: view.getUint16(position + 10, true),
    crc: view.getUint32(position + 16, true),
    compressedSize: view.getUint32(position + 20, true),
    size: view.getUint32(position + 24, true),
    localOffset: view.getUint32(position + 42, true),
    name: archive.subarray(position + CENTRAL_SIZE, position + CENTRAL_SIZE + nameLength),
    next,
  }
}

// The local header has a name and an extra field of its own, whose lengths can differ from the central directory's.
function dataStart(view: DataView, offset: number, name: string): number {
  if (offset + LOCAL_SIZE > view.byteLength || view.getUint32(offset, true) !== LOCAL_SIGNATURE) {
    throw new ZipRefused(`the local header of ${name} is missing or damaged`)
  }

  return offset + LOCAL_SIZE + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true)
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, i) => byte === right[i])
}

function stored(data: Uint8Array, entry: CentralHeader, name: string): Uint8Array {
  if (data.length !== entry.size) {
    throw new ZipRefused(`${name} is stored in ${data.length} bytes but declares ${entry.size}`)
  }

  // A copy, because slice on a Buffer would share the archive's memory.
  return new Uint8Array(data)
}

// maxOutputLength stops a header that lies about the size from inflating more than the limit.
function inflated(data: Uint8Array, entry: CentralHeader, name: string): Uint8Array {
  let content: Uint8Array

  try {
    content = inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES })
  } catch (error) {
    if (error instanceof RangeError && 'code' in error && error.code === 'ERR_BUFFER_TOO_LARGE') {
      throw new ZipRefused(`${name} inflates to more than ${MAX_ENTRY_BYTES} bytes`, { tooLarge: true })
    }

    throw new ZipRefused(`${name} does not inflate: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (content.length !== entry.size) {
    throw new ZipRefused(`${name} inflates to ${content.length} bytes but declares ${entry.size}`)
  }

  return new Uint8Array(content.buffer, content.byteOffset, content.byteLength)
}

function entryContent(view: DataView, archive: Uint8Array, entry: CentralHeader, name: string): Uint8Array {
  if ((entry.flags & ENCRYPTED) !== 0) {
    throw new ZipRefused(`${name} is encrypted`)
  }

  if (entry.method !== STORED && entry.method !== DEFLATED) {
    throw new ZipRefused(`${name} uses compression method ${entry.method}`)
  }

  if (entry.size > MAX_ENTRY_BYTES) {
    throw new ZipRefused(`${name} is larger than ${MAX_ENTRY_BYTES} bytes`, { tooLarge: true })
  }

  const start = dataStart(view, entry.localOffset, name)

  if (start + entry.compressedSize > view.byteLength) {
    throw new ZipRefused(`the data of ${name} runs past the end of the archive`)
  }

  const data = archive.subarray(start, start + entry.compressedSize)
  const file = entry.method === STORED ? stored(data, entry, name) : inflated(data, entry, name)

  if (crc32(file) !== entry.crc) {
    throw new ZipRefused(`${name} fails its CRC-32 check`)
  }

  return file
}

// Every offset is checked before it is read, so a damaged archive is refused
// as unreadable and never surfaces as a RangeError from the DataView.
export function zipEntry(archive: Uint8Array, name: string): Uint8Array | null {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength)
  const { count, offset, end } = directory(view)
  const wanted = new TextEncoder().encode(name)
  let position = offset

  for (let i = 0; i < count; i += 1) {
    const entry = centralHeader(view, archive, position, end)

    if (sameBytes(entry.name, wanted)) {
      return entryContent(view, archive, entry, name)
    }

    position = entry.next
  }

  return null
}
