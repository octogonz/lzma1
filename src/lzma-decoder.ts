/**
 * LZMA decoder: turns range-coded symbols back into literals and matches.
 *
 * Ported from XZ for Java (0BSD), `src/org/tukaani/xz/lzma/LZMADecoder.java`,
 * by Lasse Collin and Igor Pavlov.
 *
 * Contract adaptations, pinned by the recorded malformed-stream
 * expectations in `fixtures/malformed.json`:
 * - `decode(outLimit, inLimit)` drives the loop by the number of bytes
 *   produced (`outPos`) and the input position, instead of the Java code's
 *   `LZDecoder` window limit, because the input arrives in chunks and the
 *   output goes to a sink. `outPos` also provides the position bits
 *   (`posState` and the literal subcoder index). The Java code reads them
 *   from `LZDecoder.getPos()`, its position in a circular dictionary
 *   buffer that `LZMAInputStream.getDictSize` rounds up to a multiple of
 *   16 for exactly this purpose, so that position equals `outPos` modulo
 *   16. The position masks keep at most the low 4 bits (`pb`, `lp` <= 4),
 *   so the two agree for every dictionary size.
 * - The end marker returns `true` instead of surfacing as the error the
 *   Java code's `lz.repeat` raises for it; a match that would cross the
 *   declared size is an error.
 */

import type { LzDecoder } from "./lz-decoder.js";
import {
	ALIGN_BITS,
	DIST_MODEL_END,
	DIST_MODEL_START,
	getDistState,
	LengthCoder,
	LiteralCoder,
	LiteralSubcoder,
	LOW_SYMBOLS,
	LzmaCoder,
	MATCH_LEN_MIN,
	MID_SYMBOLS,
} from "./lzma-coder.js";
import type { RangeDecoder } from "./range-decoder.js";

/** Distance value that marks the end of the stream (0xFFFFFFFF as int32). */
const END_MARKER_DIST = -1;

export class LzmaDecoder extends LzmaCoder {
	// Package-private in Java: the literal subdecoders read these.
	readonly lz: LzDecoder;
	readonly rc: RangeDecoder;
	private readonly literalDecoder: LiteralDecoder;
	private readonly matchLenDecoder = new LengthDecoder();
	private readonly repLenDecoder = new LengthDecoder();

	/** Number of bytes decoded so far. */
	outPos = 0;

	/**
	 * Probability array handed in for reuse. The structured probability
	 * model of this translation cannot reuse it, so it is ignored and
	 * none is handed back. Ignoring it only forgoes the allocation the
	 * reuse would save; decoding is unaffected.
	 */
	readonly probs: Uint16Array | undefined = undefined;

	constructor(lz: LzDecoder, rc: RangeDecoder, lc: number, lp: number, pb: number, probs?: Uint16Array) {
		super(pb);
		this.lz = lz;
		this.rc = rc;
		this.literalDecoder = new LiteralDecoder(this, lc, lp);
		this.reset();
	}

	override reset(): void {
		super.reset();
		this.literalDecoder.reset();
		this.matchLenDecoder.reset();
		this.repLenDecoder.reset();
	}

	/**
	 * Returns true if LZMA end marker was detected. It is encoded as
	 * the maximum match distance which with int32 values becomes -1.
	 */
	private endMarkerDetected(): boolean {
		return this.reps[0] === END_MARKER_DIST;
	}

	/**
	 * Decodes symbols until `outLimit` bytes have been produced or the
	 * input position passes `inLimit`.
	 *
	 * @returns `true` if the end marker was decoded
	 */
	decode(outLimit: number, inLimit: number): boolean {
		const rc = this.rc;
		const lz = this.lz;
		let endMarker = false;

		while (this.outPos < outLimit && rc.pos <= inLimit) {
			const posState = this.outPos & this.posMask;

			if (rc.decodeBit(this.isMatch[this.state.get()], posState) === 0) {
				this.literalDecoder.decode();
				++this.outPos;
			} else {
				const len = rc.decodeBit(this.isRep, this.state.get()) === 0
					? this.decodeMatch(posState)
					: this.decodeRepMatch(posState);

				if (this.endMarkerDetected()) {
					endMarker = true;
					break;
				}

				if (len > outLimit - this.outPos) {
					throw new Error("Corrupted input: data exceeds the declared size");
				}

				lz.repeat(this.reps[0], len);
				this.outPos += len;
			}
		}

		rc.normalize();

		return endMarker;
	}

	private decodeMatch(posState: number): number {
		this.state.updateMatch();

		this.reps[3] = this.reps[2];
		this.reps[2] = this.reps[1];
		this.reps[1] = this.reps[0];

		const len = this.matchLenDecoder.decode(this.rc, posState);
		const distSlot = this.rc.decodeBitTree(this.distSlots[getDistState(len)]);

		if (distSlot < DIST_MODEL_START) {
			this.reps[0] = distSlot;
		} else {
			const limit = (distSlot >> 1) - 1;
			this.reps[0] = (2 | (distSlot & 1)) << limit;

			if (distSlot < DIST_MODEL_END) {
				this.reps[0] |= this.rc.decodeReverseBitTree(this.distSpecial[distSlot - DIST_MODEL_START]);
			} else {
				this.reps[0] |= this.rc.decodeDirectBits(limit - ALIGN_BITS) << ALIGN_BITS;
				this.reps[0] |= this.rc.decodeReverseBitTree(this.distAlign);
			}
		}

		return len;
	}

	private decodeRepMatch(posState: number): number {
		if (this.rc.decodeBit(this.isRep0, this.state.get()) === 0) {
			if (this.rc.decodeBit(this.isRep0Long[this.state.get()], posState) === 0) {
				this.state.updateShortRep();
				return 1;
			}
		} else {
			let tmp: number;

			if (this.rc.decodeBit(this.isRep1, this.state.get()) === 0) {
				tmp = this.reps[1];
			} else {
				if (this.rc.decodeBit(this.isRep2, this.state.get()) === 0) {
					tmp = this.reps[2];
				} else {
					tmp = this.reps[3];
					this.reps[3] = this.reps[2];
				}

				this.reps[2] = this.reps[1];
			}

			this.reps[1] = this.reps[0];
			this.reps[0] = tmp;
		}

		this.state.updateLongRep();

		return this.repLenDecoder.decode(this.rc, posState);
	}
}

class LiteralDecoder extends LiteralCoder {
	private readonly decoder: LzmaDecoder;
	private readonly subdecoders: LiteralSubdecoder[];

	constructor(decoder: LzmaDecoder, lc: number, lp: number) {
		super(lc, lp);
		this.decoder = decoder;

		this.subdecoders = Array.from(
			{ length: 1 << (lc + lp) },
			() => new LiteralSubdecoder(decoder),
		);
	}

	reset(): void {
		for (let i = 0; i < this.subdecoders.length; ++i) {
			this.subdecoders[i].reset();
		}
	}

	decode(): void {
		const decoder = this.decoder;
		// The Java code reads the position bits from the dictionary
		// position; `outPos` is equivalent (see the module comment).
		const i = this.getSubcoderIndex(decoder.lz.getByte(0), decoder.outPos);
		this.subdecoders[i].decode();
	}
}

class LiteralSubdecoder extends LiteralSubcoder {
	private readonly decoder: LzmaDecoder;

	constructor(decoder: LzmaDecoder) {
		super();
		this.decoder = decoder;
	}

	decode(): void {
		const decoder = this.decoder;
		const rc = decoder.rc;
		const probs = this.probs;
		let symbol = 1;

		if (decoder.state.isLiteral()) {
			do {
				symbol = (symbol << 1) | rc.decodeBit(probs, symbol);
			} while (symbol < 0x100);
		} else {
			let matchByte = decoder.lz.getByte(decoder.reps[0]);
			let offset = 0x100;
			let matchBit: number;
			let bit: number;

			do {
				matchByte <<= 1;
				matchBit = matchByte & offset;
				bit = rc.decodeBit(probs, offset + matchBit + symbol);
				symbol = (symbol << 1) | bit;
				offset &= (0 - bit) ^ ~matchBit;
			} while (symbol < 0x100);
		}

		decoder.lz.putByte(symbol & 0xFF);
		decoder.state.updateLiteral();
	}
}

class LengthDecoder extends LengthCoder {
	decode(rc: RangeDecoder, posState: number): number {
		if (rc.decodeBit(this.choice, 0) === 0) {
			return rc.decodeBitTree(this.low[posState]) + MATCH_LEN_MIN;
		}

		if (rc.decodeBit(this.choice, 1) === 0) {
			return rc.decodeBitTree(this.mid[posState]) + MATCH_LEN_MIN + LOW_SYMBOLS;
		}

		return rc.decodeBitTree(this.high) + MATCH_LEN_MIN + LOW_SYMBOLS + MID_SYMBOLS;
	}
}
