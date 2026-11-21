import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_ENTRY_BYTES, ZipRefused, zipEntry } from '../lib/zip.ts'
import { zipArchive } from './fixtures.mjs'

const REVIEW = JSON.stringify({ schema_version: 1, revision: '4f1c2d3e5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d', findings: [], fixed: [] })

// Bytes from a fixed pattern, so a run never depends on chance.
function pattern(length, step = 37) {
  return Uint8Array.from({ length }, (_, i) => (i * step + (i >> 8)) % 256)
}

function refusal(archive, name = 'review.json') {
  try {
    zipEntry(archive, name)
  } catch (error) {
    assert.ok(error instanceof ZipRefused, String(error))
    assert.equal(error.name, 'ZipRefused')

    return error
  }

  assert.fail('the archive was read')
}

test('zipEntry: a deflated and a stored entry come back byte for byte, streamed or with the sizes in the local headers', () => {
  const binary = pattern(4000)

  for (const streamed of [true, false]) {
    const archive = zipArchive(
      [
        { name: 'report.md', data: '# Report\n' },
        { name: 'review.json', data: REVIEW },
        { name: 'findings.bin', data: binary, method: 'stored' },
      ],
      { streamed },
    )

    assert.equal(new TextDecoder().decode(zipEntry(archive, 'review.json')), REVIEW, `streamed ${streamed}`)
    assert.deepEqual(zipEntry(archive, 'findings.bin'), binary, `streamed ${streamed}`)
    assert.deepEqual(zipEntry(new Uint8Array(archive), 'report.md'), new TextEncoder().encode('# Report\n'))
  }
})

test('zipEntry: reads an archive that sits inside a larger buffer and one with an empty entry, and a stored entry is a copy', () => {
  const archive = zipArchive([
    { name: 'empty.txt', data: '' },
    { name: 'review.json', data: REVIEW, method: 'stored' },
  ])

  const padded = new Uint8Array(archive.length + 16)

  padded.set(archive, 8)

  const entry = zipEntry(padded.subarray(8, 8 + archive.length), 'review.json')

  padded.fill(0)

  assert.deepEqual(entry, new TextEncoder().encode(REVIEW))
  assert.deepEqual(zipEntry(archive, 'empty.txt'), new Uint8Array(0))
})

test('zipEntry: a name the archive lacks is null, and dir/review.json is not review.json', () => {
  const archive = zipArchive([
    { name: 'dir/review.json', data: REVIEW },
    { name: 'review.json.bak', data: REVIEW },
  ])

  assert.equal(zipEntry(archive, 'review.json'), null)
  assert.equal(zipEntry(archive, 'REVIEW.JSON'), null)
  assert.equal(zipEntry(zipArchive([]), 'review.json'), null)
  assert.equal(new TextDecoder().decode(zipEntry(archive, 'dir/review.json')), REVIEW)
})

test('zipEntry: an entry of MAX_ENTRY_BYTES reads, and one byte more is too large, stored or deflated', () => {
  const limit = new Uint8Array(MAX_ENTRY_BYTES).fill(0x61)
  const over = new Uint8Array(MAX_ENTRY_BYTES + 1).fill(0x61)

  assert.equal(MAX_ENTRY_BYTES, 1024 * 1024)

  for (const method of ['deflated', 'stored']) {
    assert.equal(zipEntry(zipArchive([{ name: 'review.json', data: limit, method }]), 'review.json').length, MAX_ENTRY_BYTES, method)

    const error = refusal(zipArchive([{ name: 'review.json', data: over, method }]))

    assert.equal(error.tooLarge, true, method)
    assert.equal(error.message, 'review.json is larger than 1048576 bytes')
  }
})

test('zipEntry: a deflated entry whose headers say 10 bytes and which inflates past the limit is too large', () => {
  const bomb = zipArchive([{ name: 'review.json', data: new Uint8Array(4 * MAX_ENTRY_BYTES), size: 10 }])
  const error = refusal(bomb)

  assert.equal(error.tooLarge, true)
  assert.equal(error.message, 'review.json inflates to more than 1048576 bytes')
})

test('zipEntry: an archive the reader cannot read is refused with tooLarge false and the cause in plain words', () => {
  const archive = zipArchive([{ name: 'review.json', data: REVIEW }])
  const notZip = pattern(1000)

  const cases = [
    ['not a zip', notZip, 'no end of central directory record'],
    ['empty', new Uint8Array(0), 'no end of central directory record'],
    ['cut in half', archive.subarray(0, archive.length >> 1), 'no end of central directory record'],
    ['wrong CRC-32', zipArchive([{ name: 'review.json', data: REVIEW, crc: 1 }]), 'review.json fails its CRC-32 check'],
    [
      'wrong stored CRC-32',
      zipArchive([{ name: 'review.json', data: REVIEW, crc: 1, method: 'stored' }]),
      'review.json fails its CRC-32 check',
    ],
    ['method 12', zipArchive([{ name: 'review.json', data: REVIEW, method: 12 }]), 'review.json uses compression method 12'],
    ['wrong size', zipArchive([{ name: 'review.json', data: REVIEW, size: 10 }]), /^review\.json inflates to \d+ bytes but declares 10$/],
    [
      'stored size',
      zipArchive([{ name: 'review.json', data: REVIEW, size: 10, method: 'stored' }]),
      /^review\.json is stored in \d+ bytes/,
    ],
  ]

  for (const [label, bytes, message] of cases) {
    const error = refusal(bytes)

    assert.equal(error.tooLarge, false, label)
    assert.match(error.message, message instanceof RegExp ? message : new RegExp(`^${RegExp.escape(message)}$`), label)
  }
})

// A copy of the archive with `value` written over `size` bytes at `offset`.
function patched(archive, offset, value, size) {
  const copy = Buffer.from(archive)

  if (size === 2) {
    copy.writeUInt16LE(value, offset)
  } else {
    copy.writeUInt32LE(value, offset)
  }

  return copy
}

test('zipEntry: an offset or a length that points outside the archive is unreadable, never a RangeError', () => {
  const archive = zipArchive([{ name: 'review.json', data: REVIEW }], { streamed: false })
  const end = archive.length - 22
  const central = archive.readUInt32LE(end + 16)
  const deflated = archive.readUInt32LE(central + 20)

  const cases = [
    ['directory offset', patched(archive, end + 16, archive.length, 4)],
    ['directory size', patched(archive, end + 12, archive.length, 4)],
    ['entry count', patched(archive, end + 10, 2, 2), 'missing.json'],
    ['name length', patched(archive, central + 28, 0xfff0, 2)],
    ['local offset', patched(archive, central + 42, archive.length - 10, 4)],
    ['local offset to the directory', patched(archive, central + 42, central, 4)],
    ['compressed size', patched(archive, central + 20, archive.length, 4)],
    ['compressed size cut', patched(archive, central + 20, deflated - 4, 4)],
    ['local extra length', patched(archive, 28, 0xffff, 2)],
    ['zip64 count', patched(patched(archive, end + 10, 0xffff, 2), end + 8, 0xffff, 2)],
    ['zip64 offset', patched(archive, end + 16, 0xffffffff, 4)],
    ['zip64 size', patched(archive, end + 12, 0xffffffff, 4)],
    ['central signature', patched(archive, central, 0x01020304, 4)],
    ['encrypted', patched(archive, central + 8, 1, 2)],
  ]

  for (const [label, bytes, name] of cases) {
    assert.equal(refusal(bytes, name).tooLarge, false, label)
  }
})

test('zipEntry: finds the end record behind a comment of up to 65535 bytes', () => {
  const archive = zipArchive([{ name: 'review.json', data: REVIEW }])
  const comment = new Uint8Array(0xffff).fill(0x20)
  const withComment = Buffer.concat([patched(archive, archive.length - 2, comment.length, 2), comment])

  assert.equal(new TextDecoder().decode(zipEntry(withComment, 'review.json')), REVIEW)
  assert.equal(refusal(Buffer.concat([withComment, new Uint8Array(1)])).message, 'no end of central directory record')
})
