# Verification of the LZMA coders

This document describes how the LZMA coders are checked against **XZ for Java**
at commit `6925f81244a99d0ea4f3fd021938e2ee1e6de2eb`
(<https://github.com/tukaani-project/xz-java>). The coders start from a
translation that follows the Java code's structure, names and control flow, so
each file can be compared with its Java source side by side. Every deliberate
departure from the Java code is recorded below: language adaptations, the
decoder's deviation from the Java decoder, and behavior-preserving
transformations, each transformation with the argument that it leaves behavior
unchanged. The arguments form a chain: first the translation, recorded file by
file, then each transformation, applied to the code as the ones before it leave
it. The README's Verification section explains why the arguments are needed
beyond the tests.

## Java sources and file mapping

| Port file                                 | Java source (`src/org/tukaani/xz/...` at the pinned commit)              |
| ----------------------------------------- | ------------------------------------------------------------------------ |
| `src/range-coder.ts`                      | `rangecoder/RangeCoder.java`                                             |
| `src/range-encoder.ts`                    | `rangecoder/RangeEncoder.java`, `rangecoder/RangeEncoderToBuffer.java`   |
| `src/range-decoder.ts`                    | `rangecoder/RangeDecoder.java`, `rangecoder/RangeDecoderFromStream.java` |
| `src/lzma-coder.ts`                       | `lzma/LZMACoder.java`, `lzma/State.java`                                 |
| `src/lzma-encoder.ts`                     | `lzma/LZMAEncoder.java`                                                  |
| `src/lzma-encoder-fast.ts`                | `lzma/LZMAEncoderFast.java`                                              |
| `src/lzma-encoder-normal.ts`              | `lzma/LZMAEncoderNormal.java`, `lzma/Optimum.java`                       |
| `src/lzma-decoder.ts`                     | `lzma/LZMADecoder.java`                                                  |
| `src/lz-encoder.ts`                       | `lz/LZEncoder.java`, `lz/Matches.java`, `lz/MatchLength.java`            |
| `src/lz-decoder.ts`                       | `lz/LZDecoder.java`                                                      |
| `src/hash234.ts`                          | `lz/Hash234.java`, `lz/CRC32Hash.java`                                   |
| `src/hc4.ts`                              | `lz/HC4.java`                                                            |
| `src/bt4.ts`                              | `lz/BT4.java`                                                            |
| `createEncoder` in `src/alone-encoder.ts` | `lzma/LZMAEncoder.getInstance`, `lz/LZEncoder.getInstance`               |

The API code (`options.ts`, `lzma.ts`, `header.ts`, `index.ts`,
`web-streams.ts`, `utf8.ts`, `output-buffer.ts`, `crc32.ts`, and the rest of
`alone-encoder.ts` and `alone-decoder.ts`) is the library's own interface around
the coders and is not derived from the Java code.

## Translation

The core files are translated from the Java code at the pinned commit, keeping
the repository's file names, layout and porting rules. Translation policy: Java
`int[]` becomes `Int32Array` and `byte[]` becomes `Uint8Array` (typed arrays are
the faithful rendering of Java primitive arrays, since stores narrow the same
way); `short[]` probabilities become `Uint16Array`; Java's `long low` in the
range encoder becomes a JavaScript number, backed by the bound argument in the
hazard checklist; and the API code's known-size plumbing (the input size and a
reduced optimum-window size passed into the coders) is kept.

### File-by-file ledger

Every difference from the Java code found in the side-by-side review of the
translation:

- **range-coder.ts** (`RangeCoder.java`): constants and `initProbs` are module
  exports instead of statics; `short[]` probabilities are `Uint16Array` behind
  the `Probs` alias; `(range & TOP_MASK) == 0` is expressed as the unsigned
  `range < TOP_VALUE`, equivalent for the unsigned-in-number representation.
- **range-encoder.ts** (`RangeEncoder.java`, `RangeEncoderToBuffer.java`): the
  Java code's method set (`encodeBit`, `encodeBitTree(probs, symbol)` with the
  tree size taken from `probs.length`, `encodeReverseBitTree`,
  `encodeDirectBits`, `shiftLow`, price statics as functions). `low` is a
  bounded number (bound in the hazard checklist). The fixed output buffer plus
  `ArrayCache` is a growable buffer with `writeBytes`/`take`/`finish`, and
  `finish` returns the bytes instead of `bufPos`.
- **range-decoder.ts** (`RangeDecoder.java`, `RangeDecoderFromStream.java`):
  `normalize`, `decodeBit`, `decodeBitTree`, `decodeReverseBitTree`,
  `decodeDirectBits`. `Integer.compareUnsigned(code, bound) < 0` is a plain `<`
  on unsigned-in-number values. `(code - range) >>> 31` wraps through ToUint32
  to the same 32-bit pattern as Java's int subtraction, including the
  `code = 2^32-1, range = 2^31-1` corner, where both take the same branch.
  Chunked input via `setInput` with a throwing `readByte` replaces the input
  stream, whose read past the end throws `EOFException`. `init` makes two header
  checks, including a `code == range` check the Java decoder does not make; the
  malformed-stream records cover both.
- **lzma-coder.ts** (`LZMACoder.java`, `State.java`): structured probability
  arrays (`isMatch[12][16]`, per-tree `Uint16Array`s, the ten `distSpecial`
  trees of 2 to 32 leaves) and the `State` class with the Java code's
  transitions. Nested `LiteralCoder.LiteralSubcoder` and `LengthCoder` become
  top-level abstract classes; subclasses receive the outer coder or the range
  coder as an explicit parameter. `probsSize` is an exported function with the
  flat-layout value (1846 plus the literal tables), because the API code uses it
  as the key of its probability-reuse pool, which the translated decoder leaves
  inert (see lzma-decoder.ts). `getDistState` stays a module function.
- **hash234.ts** (`Hash234.java`, `CRC32Hash.java`): a faithful translation. The
  CRC table comes from `crc32.ts` (the same IEEE 802.3 table; byte masks make
  the signedness of entries irrelevant up to the hash masks); `clear()` is added
  for pooled reuse; `ArrayCache` and `getMemoryUsage` are dropped with the LZMA2
  scope.
- **lz-encoder.ts** (`LZEncoder.java`, `Matches.java`, `MatchLength.java`):
  near-faithful. A config object instead of the long parameter list,
  `getInstance` moved to `createEncoder`; `Matches` on `Int32Array`;
  `MatchLength.getLen` is the module function `getMatchLen` with the same
  byte-loop semantics, without the Java code's word-at-a-time `src9` variant;
  the two `getByte`/`getMatchLen` overloads are `getByte`/`getByteAt` and a
  merged `getMatchLen(forward, dist, lenLimit)`; a known input size caps the
  buffer (bound in the hazard checklist); `reset()` is added for pooled reuse;
  `setFlushing`, `copyUncompressed`, `setPresetDict` and `verifyMatches` are
  dropped with the streaming/LZMA2 scope; asserts are dropped.
- **hc4.ts / bt4.ts** (`HC4.java` / `BT4.java`): near-faithful. The private
  `movePos()` override is named `movePosition` to avoid colliding with the base
  method it wraps. The pooled `reset()` advances `lzPos` by `cyclicSize` so
  stale table entries fall out as `delta >= cyclicSize`, clearing only near the
  normalization bound, so a reused encoder sees the tables as empty. BT4 has two
  representation choices that preserve output: locals hoisted across the search
  loop, and the `tree[pair]`/`tree[pair + 1]` children loaded before the byte
  comparison instead of at use. The load reorder preserves behavior because the
  search path from the root never revisits a node: the slots written through
  `ptr0`/`ptr1` belong to already-visited nodes and are therefore disjoint from
  the node read at `pair` below them.
- **lzma-encoder.ts** (`LZMAEncoder.java`): structured probabilities,
  `State`-typed price helpers,
  `LiteralEncoder`/`LiteralSubencoder`/`LengthEncoder` with per-tree arrays, and
  unconditional price recomputation (`updateDistPrices` always walks the
  tables). `getDistSlot` uses `31 - Math.clz32(dist)` for
  `Integer.numberOfLeadingZeros`. The end-marker distance stays `-1`, and
  `(2 | (distSlot & 1)) << footerBits` wraps to the same int32 negative base as
  Java, so `distReduced` matches bit for bit.
  `encodeForLZMA1`/`encodeLZMA1EndMarker` are `encode`/`encodeEndMarker` for the
  API code's callers; `restart(rc)` is added for the pool; the LZMA2 entry
  points, `getPendingSize`, the `uncompressedSize` accounting and
  `getMemoryUsage` are dropped; `readAhead` is public where Java has
  package-private.
- **lzma-encoder-fast.ts** (`LZMAEncoderFast.java`): faithful; only the
  shared-base differences above apply.
- **lzma-encoder-normal.ts** (`LZMAEncoderNormal.java`, `Optimum.java`): the
  Java code's `Optimum` objects (`state`, `reps`, `price`, `optPrev`,
  `backPrev`, `prev1IsLiteral`, `hasPrev2`, `optPrev2`, `backPrev2`, with
  `set1`/`set2`/`set3`/`reset`), `convertOpts`, `updateOptStateAndReps`, and the
  Java code's `calc1BytePrices`: unconditional literal pricing and its own
  short-rep guard (`optPrev == optCur || backPrev != 0`), with `nextIsByte`
  gating only the literal + rep0 extension. The LZMA SDK 18.06 variant, which
  considers short reps only in literal states and skips pricing a literal when a
  short rep reaches the next position, produces different output and is not
  used. The `opts` allocation honors the API code's known-size cap (bound in the
  hazard checklist). Java's `System.arraycopy` of reps becomes `TypedArray.set`;
  asserts are dropped.
- **lzma-decoder.ts** (`LZMADecoder.java`): the Java code's symbol-structured
  decode (`decodeMatch`, `decodeRepMatch`, `LiteralDecoder`/`LiteralSubdecoder`,
  `LengthDecoder`). Differences in the interface to the API code, each covered
  by the malformed-stream records:
  - The loop is bounded by produced bytes and the input position
    (`decode(outLimit, inLimit)`) instead of the LZ window limit.
  - `posState` and the literal position come from `outPos`. The Java code reads
    them from `LZDecoder.getPos()`, its position in a circular dictionary buffer
    that `LZMAInputStream.getDictSize` rounds up to a multiple of 16 for exactly
    this purpose, so that position equals `outPos` modulo 16; the masks keep at
    most the low 4 bits (`pb`, `lp` <= 4), so the two agree for every dictionary
    size.
  - The end marker returns `true` instead of surfacing as the `repeat` error
    `LZMAInputStream` special-cases.
  - A match crossing the declared size throws before writing; the Java code
    splits it via `pendingLen` and its caller errors on the size mismatch, the
    same outcome kind.
  - The `probs` reuse parameter is accepted and ignored, and `probs` reads back
    `undefined`, which leaves the decoder pool inert without changing any
    decoded byte.
- **lz-decoder.ts** (`LZDecoder.java`): an adaptation to the library's interface
  rather than a translation: a growing buffer with a sink replaces the fixed
  dictionary flushed by the caller; `repeat`'s distance validation against the
  written history matches the Java code's `dist >= full` check in outcome kind;
  `pendingLen` is unnecessary since the only output limit is the declared size,
  enforced in `lzma-decoder.ts`. The `copyWithin` fast path for non-overlapping
  long copies preserves output by the same forward-copy semantics.
- **`createEncoder` in alone-encoder.ts**: it carries only the known-size
  plumbing.

### Semantic deviation

The decoder does not check the range coder's final state when the declared size
is reached. At that point `LZMAInputStream` requires a finished range coder
(`code == 0`), or, in its relaxed mode, an end marker followed by a finished
range coder, and otherwise rejects the stream. The library has `isFinished()`,
but the API code does not call it there. So corruption after the last symbol
needed for the declared size goes undetected, and a corrupt stream can be
accepted at the declared length with wrong bytes where the Java decoder reports
an error. A check at the declared size would close both without conflicting with
the end-marker leniency, which ends at a marker before the declared size; it
would change which inputs the library accepts.

The fixtures record every decoder outcome that differs from the Java decoder's,
in four classes described in `fixtures/README.md`; this deviation accounts for
two of them. `fixtures/generate.ts` stops on any other difference.

### Java-to-JS hazard checklist

- **Signed versus unsigned shifts:** every Java `>>>` kept as `>>>`; `>>` only
  where Java has it (`prevByte >> (8 - lc)`, `distSlot >> 1`), on non-negative
  operands.
- **Int overflow and truncation:** `range`, `code` and `bound` stay in [0, 2^32)
  with `>>> 0` after every left shift; products `(range >>> 11) * prob < 2^32`
  are exact in doubles; `low` is bounded below; price sums stay below 2^30
  (`INFINITY_PRICE`) and fit int32.
- **`long` handling:** `RangeEncoder.low` and `cacheSize` (a byte count, far
  below 2^53) are the only Java longs; both are plain numbers. Bound for `low`:
  before `shiftLow`, `low < 2^24 * 256 + bound < 2^33` (24 low bits shifted up
  by 8, plus one addition of `bound < 2^32`), so the carry is exactly
  `floor(low / 2^32)` in {0, 1}, doubles represent every value exactly, and the
  24-bit wrap is done as `(low & 0xFFFFFF) * 256`.
- **Byte sign extension:** all byte reads come from `Uint8Array` (0..255), so
  Java's `& 0xFF` masks are implicit; byte equality comparisons are unaffected
  by Java's signed bytes; BT4 and HC4's ordered comparison uses the unsigned
  values directly, as Java's masked values do.
- **Integer division:** Java `/` on ints appears only in constants and table
  setup where the operands divide exactly; `Math.floor(low / 2^32)` implements
  `low >>> 32` for the 33-bit `low`.
- **Typed-array narrowing:** probability stores rely on `Uint16Array` masking
  exactly like Java's `(short)` casts (the values stay in 0..2047 anyway);
  `reps`, `Matches` and price tables on `Int32Array` wrap like Java ints, and
  the end-marker `-1` round-trips through `Int32Array` intentionally.
- **Zero-initialization:** typed arrays zero-fill like Java arrays; the hash
  tables and chains depend on it, and `clear()` restores it for reuse; `Optimum`
  fields initialize to Java's default values.
- **int32 `<<` wrap sites,** verified one by one:
  `(2 | (distSlot & 1)) << footerBits` (a negative base for slot 63, intended),
  `symbol << 1` chains (bounded below 2^17), `matchByte << 1` (bounded below
  2^17 within a literal), `result << 1` in direct bits (bounded below 2^27).
- **Array bounds.** Java throws `ArrayIndexOutOfBoundsException` on an
  out-of-range index; a typed array silently drops an out-of-range write and
  reads `undefined`, which then compares unequal to every byte or turns
  arithmetic into `NaN`. So an escaped index that would crash the Java code can
  corrupt the port's output instead. XZ for Java commit `ac1aeb1` (included in
  the pinned commit) is an instance of the class: it fixed an index escape in
  `MatchLength.java`'s word-at-a-time match-length reader, a part of that file
  the port does not translate (the port uses the byte loop). The computed-index
  sites of the translated files:
  - _Index values._ Every computed index in the translated files is computed by
    a statement that corresponds to a Java statement, from values that the
    translation keeps equal (the integer-semantics items above). So for the same
    input, every index the port computes is the index the Java code computes,
    and an index the Java code never takes out of range is never out of range in
    the port, provided the port's array is at least as long as the Java code's.
    What remains to check is the allocations and the sites without a Java
    counterpart.
  - _Allocations equal to the Java code's:_ probability arrays (`isMatch`,
    `isRep*`, `isRep0Long`, `distSlots`, the ten `distSpecial` trees,
    `distAlign`, literal subcoders of `0x300`, length coders'
    `choice`/`low`/`mid`/`high`), price tables (`fullDistPrices[4][128]`,
    `distSlotPrices[4][getDistSlot(dictSize - 1) + 1]`, `alignPrices[16]`,
    length prices per position state), `reps[4]`, `Matches(niceLen - 1)`, the
    hash tables (`1 << 10`, `1 << 16`, `getHash4Size(dictSize)`), the HC4 chain
    (`cyclicSize`) and the BT4 tree (`cyclicSize * 2`), all with the same
    `dictSize` the Java code is given.
  - _`opts` under the known-size cap_ (`lzma-encoder-normal.ts`; the Java code
    always allocates 4096). With a known input of N bytes the API code allocates
    `min(sizeClass + 2, 4096)` entries, where `sizeClass` is the least power of
    two at least `max(N, 64)`. Every index `getNextSymbol` and its helpers touch
    is at most `optEnd`; at the start of a block
    `optEnd <= min(lz.getAvail(), 273)`; in the loop, `avail` starts at
    `A0 = min(lz.getAvail(), 4095)` and decreases by one per position, and every
    write lands at `optCur + 1 + len` (literal + rep0, `len <= avail - 1`),
    `optCur + len` (`len <= avail`, matches shortened to `avail`), or
    `optCur + len + 1 + len2` (`len2 <= avail - len - 1`), each at most
    `optCur + avail = A0`. `lz.getAvail()` counts bytes from the read position
    to the end of the written input, at most N. So every index is at most
    `min(N, 4095) <= sizeClass + 1`, inside the allocation.
  - _The LZ encoder window under the known-size cap_ (`lz-encoder.ts`). The
    buffer is
    `min(keepSizeBefore + keepSizeAfter + reserve, sizeClass + keepSizeAfter)`
    bytes; the first term is the Java code's size. When the cap applies, the
    read position stays below `N <= sizeClass`, so the window never moves
    (`readPos >= buf.length - keepSizeAfter` is never reached), exactly as in
    the Java code, whose larger buffer does not move either; positions are
    absolute in both. Writes are clamped by `fillWindow` to the buffer. Every
    read (`getByte`, `getByteAt`, `getMatchLen`, the match finders'
    `buf[readPos ± ...]`) addresses written data at a distance the Java code
    also reads, and reads ahead at most `lenLimit <= avail` bytes, so it stays
    below `writePos <= buf.length`. The ported `getMatchLen` is the byte loop,
    so the over-read that `ac1aeb1` fixed has no counterpart here.
  - _The decoder dictionary_ (`lz-decoder.ts`; growing buffer, no Java
    counterpart). `repeat` throws unless `dist < history` (the written bytes, or
    the full buffer once wrapped), before any index is formed, so `back` lies in
    `[0, buf.length)`. `getByte(dist)` is called with 0 (the previous byte; at
    position 0 it reads the zero-initialized last slot, as the Java code reads
    the slot `LZDecoder.reset` zeroes) or with `reps[0]`, which is either the
    initial 0 or a distance a previous `repeat` validated against a history that
    has only grown since. `putByte` and `repeat` grow or flush the buffer when
    `pos` reaches its end, before the next write.
  - _Range coder streams_ (no Java counterpart): the encoder's `writeByte` calls
    `ensureCapacity` before each write; the decoder's `readByte` throws an
    explicit truncation error when the input is exhausted instead of indexing
    past it.
  - _Bit-tree and table indices from decoded data:_ tree walks stay inside their
    tree by construction (`decodeBitTree` builds an index below `probs.length`),
    a decoded `distSlot` is below 64 and selects `distSpecial[distSlot - 4]`
    only for slots 4 to 13, `state` stays in 0..11 through `State`'s
    transitions, and `posState` and the literal subcoder index are masked. These
    are the Java code's values on the same input, as above.
