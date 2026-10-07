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

## Behavior-preserving transformations

Each entry below changes how the translated code stores data or where it does
work, and argues that behavior is unchanged for every input. Each applies to the
code as the entries before it leave it. An entry that only prepares the next one
says so.

### Probabilities in one flat array

Change, in `lzma-coder.ts`, `range-encoder.ts`, `range-decoder.ts`,
`lzma-encoder.ts` and `lzma-decoder.ts`: all probabilities of a coder live in
one `Uint16Array`, in the layout the LZMA SDK and liblzma use.

1. `lzma-coder.ts` defines the layout: `IS_MATCH` 0, `IS_REP` 192, `IS_REP0`
   204, `IS_REP1` 216, `IS_REP2` 228, `IS_REP0_LONG` 240, `DIST_SLOT_OFFSET`
   432, `DIST_SPECIAL` 688, `DIST_ALIGN` 802, `MATCH_LEN` 818, `REP_LEN` 1332,
   `LITERAL` 1846; within a length coder `LEN_CHOICE` 0, `LEN_CHOICE2` 1,
   `LEN_LOW` 2, `LEN_MID` 130, `LEN_HIGH` 258, `LEN_SIZE` 514; and
   `distSpecialOffset(distSlot, base) = DIST_SPECIAL + base - distSlot - 1`.
   `LzmaCoder(lc, lp, pb)` allocates `probs` with `probsSize(lc, lp)` entries;
   `probsSize` reads `LITERAL + (0x300 << (lc + lp))`, the same value as before.
   `LiteralSubcoder(probs, literalOffset)` and `LengthCoder(probs, coder)` hold
   the outer coder's array and their offset in it; literal subcoder `i` is at
   `LITERAL + 0x300 * i`. Each `reset()` fills the regions of the arrays it used
   to fill, at the same call sites.
2. The range coder's tree methods and tree price functions take
   `(probs, offset, bits, ...)`, where the tree size used to come from
   `probs.length`; the literal loops in `LiteralSubencoder.encode` and
   `LiteralSubdecoder.decode` index the array at the subcoder's `literalOffset`
   plus their former index.
3. Every access in the encoder and decoder names the array slot:
   `isMatch[state][posState]` becomes
   `probs[IS_MATCH + (state << 4) + posState]`, `isRep*[state]` becomes
   `probs[IS_REP* + state]`, a tree becomes its offset and bit count
   (`DIST_SLOT_OFFSET + (distState << DIST_SLOT_BITS)` with 6 bits,
   `distSpecialOffset(distSlot, base)` with the footer bits, `DIST_ALIGN` with
   `ALIGN_BITS`, `coder + LEN_LOW + posState * LOW_SYMBOLS` and
   `coder + LEN_MID + posState * MID_SYMBOLS` with 3 bits, `coder + LEN_HIGH`
   with 8 bits), and the literal loops add `literalOffset`. Classes, loops and
   loop forms are unchanged.
4. Names: `DIST_SLOT_OFFSET` is the slot trees' region and `DIST_SLOT_BITS`
   their bit count; the Java code's `DIST_SLOTS` (the number of slots) keeps its
   name and expression. The literal loops keep the Java code's local `offset`,
   so a subcoder's base is `literalOffset`.
5. `LzmaDecoder` no longer declares its own `probs` field, which read
   `undefined`; the reuse parameter's explanation moves to the constructor.

Argument:

- _The mapping is one-to-one on used elements._ `isMatch[s][p]` maps to
  `16s + p`, `isRep[s]`, `isRep0[s]`, `isRep1[s]`, `isRep2[s]` to their base
  plus `s`, `isRep0Long[s][p]` to `240 + 16s + p`, `distSlots[d][j]` to
  `432 + 64d + j`, `distAlign[j]` to `802 + j`; a length coder at `c` maps
  `choice[0]`, `choice[1]` to `c`, `c + 1`, `low[p][j]` to `c + 2 + 8p + j`,
  `mid[p][j]` to `c + 130 + 8p + j`, `high[j]` to `c + 258 + j`, with `c` 818 or
  1332; literal subcoder `i` maps its `probs[j]` to `1846 + 0x300 i + j`. With
  `s < 12`, `p < 16`, `d < 4` and the former array lengths as bounds on `j`,
  each family fills exactly the half-open interval up to the next base, so the
  families are disjoint and together cover `[0, probsSize)`. The `distSpecial`
  tree of slot `s` (footer bits `f = (s >>> 1) - 1`, base
  `b = (2 | (s & 1)) << f`) maps its index `j` to `687 + b - s + j`. Its used
  indices `1 .. 2^f - 1` land on `[688 + b - s, 686 + b - s + 2^f]`, and the
  next slot's base is `b + 2^f`, so consecutive trees abut and the used entries
  of all ten trees are exactly `[688, 801]`, 114 distinct slots. Each tree's
  index 0 lands on the previous tree's last used slot (for slot 4, on the last
  slot-tree entry, 687), but index 0 of a tree is never read or written: every
  tree walk and tree price starts at index 1 and only moves to larger indices.
- _Every access reaches the mapped slot, in the same order._ Single-bit models:
  each `encodeBit`, `decodeBit` and `getBitPrice` on `a[x]` or `a[s][p]` becomes
  the same call on the mapped slot, with the same state and position values.
  Trees: the old methods walked a tree-local index from 1 and read and wrote
  `probs[index]`; the new ones walk the same tree-local index and read and write
  `probs[offset + index]`. The bound that came from `probs.length` comes from
  `1 << bits`, and at every call site `bits` is the logarithm of the former
  array's length: slot trees 64 and 6, align tree 16 and `ALIGN_BITS` 4, `low`
  and `mid` 8 and 3, `high` 256 and 8, the special tree of slot `s` `2^f` and
  `f`. So `mask`, the marker bit `symbol |= 1 << bits`, the decoder's loop test
  and its final subtraction take the same values. In `updateDistPrices`, the
  loop bound `limit`, formerly the special tree's length, is `1 << footerBits`,
  the same number. The encoder passes the special tree's `base` as computed
  above; the decoder passes `reps[0]`, which holds exactly
  `(2 | (distSlot & 1)) << limit`, the base, when the call's arguments are
  evaluated (the `|=` reads `reps[0]` before evaluating its right side and
  writes only after the tree is decoded). Literals: the old loops indexed the
  subcoder's array with `symbol >>> 8`, or `offset + matchBit + (symbol >>> 8)`
  for matched literals (`offset + matchBit + symbol` in the decoder); the new
  ones add the subcoder's `literalOffset`, whose subcoder index comes from the
  same `getSubcoderIndex`. Same values, same order, same number of iterations.
- _Bounds._ An out-of-range typed-array index would silently read `undefined` or
  drop a write instead of throwing (hazard checklist). Every mapped index lies
  inside its family's interval, because the structured index it replaces was
  inside the former array: those indices are the Java code's on the same input
  (`state` below 12 through `State`, masked `posState`, `distState` below 4,
  tree walks below the tree size, a decoded slot below 64 selecting a special
  tree only for slots 4 to 13), and the literal subcoder index from
  `getSubcoderIndex` is below `2^(lc + lp)`, the number of subcoders, so the
  largest literal index is below `probsSize(lc, lp)`, the array's length.
- _No new sharing._ Distinct used elements have distinct slots, so no write
  reaches a slot that another used element reads; the only shared slots are the
  special trees' never-accessed index 0 entries.
- _Reset._ The old resets set every element of every array to `PROB_INIT`; the
  new ones fill the regions `[0, 818)` (in the nine former model families'
  intervals), each length coder's `[c, c + 514)` (in the former `choice`, `low`,
  `mid` and `high` intervals) and each literal subcoder's `0x300` entries, at
  the same call sites and in the same order. Their union is the whole array, so
  every used element is `PROB_INIT` after a reset exactly when it was before.
  Before the first reset the array is zero-filled, as the former arrays were,
  and both encoder and decoder constructors reset before any use.
- _Construction._ With `target` ES2022, class fields are defined after `super()`
  returns. `LzmaCoder`'s constructor assigns `probs` before any subclass field
  initializer runs, so `LzmaDecoder`'s length decoder initializers and the
  encoder's and decoder's constructor bodies receive the array. No subclass
  declares `probs`, `literalOffset` or `coder`, which would redefine them as
  `undefined`; the decoder's former `probs` declaration is removed for exactly
  that reason.
- _API code._ A finished decoder's `probs` is now the array instead of
  `undefined`, so the API code keeps it as a spare and passes it to the next
  decoder of the same size, whose constructor still ignores the parameter and
  allocates its own array. No decoder reads or writes a spare, so decoding is
  unchanged; the only effect is that one finished array per size stays
  referenced.
