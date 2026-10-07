/**
 * Probability models and state machine shared by the LZMA encoder and decoder.
 *
 * Ported from XZ for Java (0BSD), `src/org/tukaani/xz/lzma/LZMACoder.java`
 * and `State.java`, by Lasse Collin and Igor Pavlov.
 *
 * The nested coder classes of the Java code (`LiteralCoder.LiteralSubcoder`,
 * `LengthCoder`) are top-level classes here, because TypeScript has no inner
 * classes; subclasses in the encoder and decoder files pass their outer
 * coder explicitly where Java captures it implicitly.
 */

import {
	initProbs,
	type Probs,
} from "./range-coder.js";

export const POS_STATES_MAX = 1 << 4;

export const MATCH_LEN_MIN = 2;
export const LOW_SYMBOLS = 1 << 3;
export const MID_SYMBOLS = 1 << 3;
export const HIGH_SYMBOLS = 1 << 8;
export const MATCH_LEN_MAX = MATCH_LEN_MIN + LOW_SYMBOLS + MID_SYMBOLS + HIGH_SYMBOLS - 1; // 273

export const DIST_STATES = 4;
export const DIST_SLOTS = 1 << 6;
export const DIST_MODEL_START = 4;
export const DIST_MODEL_END = 14;
export const FULL_DISTANCES = 1 << (DIST_MODEL_END / 2);

export const ALIGN_BITS = 4;
export const ALIGN_SIZE = 1 << ALIGN_BITS;
export const ALIGN_MASK = ALIGN_SIZE - 1;

/** Number of recent match distances ("reps") that can be reused cheaply. */
export const REPS = 4;

/** Sizes of the `distSpecial` reverse bit trees for distance slots 4-13. */
const DIST_SPECIAL_SIZES = [2, 2, 4, 4, 8, 8, 16, 16, 32, 32];

/** Distances are coded with different probabilities for lengths 2, 3, 4 and 5+. */
export function getDistState(len: number): number {
	return len < DIST_STATES + MATCH_LEN_MIN
		? len - MATCH_LEN_MIN
		: DIST_STATES - 1;
}

/**
 * Total number of probabilities of a coder with `lc` and `lp` literal
 * bits, in the single-array layout of the LZMA SDK and liblzma. Kept as
 * the key of the probability-array reuse between one-shot calls; the
 * layout itself is not used in this file.
 */
export function probsSize(lc: number, lp: number): number {
	return 1846 + (0x300 << (lc + lp));
}

/**
 * The coder state remembers the kinds of the most recent symbols
 * (literal, match, long rep, short rep). It selects which probabilities
 * are used for the next symbol.
 */
export class State {
	static readonly STATES = 12;

	private state = 0;

	constructor(other?: State) {
		if (other !== undefined) {
			this.state = other.state;
		}
	}

	reset(): void {
		this.state = LIT_LIT;
	}

	get(): number {
		return this.state;
	}

	set(other: State): void {
		this.state = other.state;
	}

	updateLiteral(): void {
		if (this.state <= SHORTREP_LIT_LIT) {
			this.state = LIT_LIT;
		} else if (this.state <= LIT_SHORTREP) {
			this.state -= 3;
		} else {
			this.state -= 6;
		}
	}

	updateMatch(): void {
		this.state = this.state < LIT_STATES ? LIT_MATCH : NONLIT_MATCH;
	}

	updateLongRep(): void {
		this.state = this.state < LIT_STATES ? LIT_LONGREP : NONLIT_REP;
	}

	updateShortRep(): void {
		this.state = this.state < LIT_STATES ? LIT_SHORTREP : NONLIT_REP;
	}

	isLiteral(): boolean {
		return this.state < LIT_STATES;
	}
}

export const STATES = State.STATES;

const LIT_STATES = 7;

const LIT_LIT = 0;
const SHORTREP_LIT_LIT = 3;
const LIT_MATCH = 7;
const LIT_LONGREP = 8;
const LIT_SHORTREP = 9;
const NONLIT_MATCH = 10;
const NONLIT_REP = 11;

function newProbsArray(count: number, size: number): Probs[] {
	return Array.from({ length: count }, () => new Uint16Array(size));
}

export abstract class LzmaCoder {
	readonly posMask: number;

	readonly reps = new Int32Array(REPS);
	readonly state = new State();

	readonly isMatch = newProbsArray(STATES, POS_STATES_MAX);
	readonly isRep: Probs = new Uint16Array(STATES);
	readonly isRep0: Probs = new Uint16Array(STATES);
	readonly isRep1: Probs = new Uint16Array(STATES);
	readonly isRep2: Probs = new Uint16Array(STATES);
	readonly isRep0Long = newProbsArray(STATES, POS_STATES_MAX);
	readonly distSlots = newProbsArray(DIST_STATES, DIST_SLOTS);
	readonly distSpecial = DIST_SPECIAL_SIZES.map((size) => new Uint16Array(size));
	readonly distAlign: Probs = new Uint16Array(ALIGN_SIZE);

	constructor(pb: number) {
		this.posMask = (1 << pb) - 1;
	}

	reset(): void {
		this.reps[0] = 0;
		this.reps[1] = 0;
		this.reps[2] = 0;
		this.reps[3] = 0;
		this.state.reset();

		for (let i = 0; i < this.isMatch.length; ++i) {
			initProbs(this.isMatch[i]);
		}

		initProbs(this.isRep);
		initProbs(this.isRep0);
		initProbs(this.isRep1);
		initProbs(this.isRep2);

		for (let i = 0; i < this.isRep0Long.length; ++i) {
			initProbs(this.isRep0Long[i]);
		}

		for (let i = 0; i < this.distSlots.length; ++i) {
			initProbs(this.distSlots[i]);
		}

		for (let i = 0; i < this.distSpecial.length; ++i) {
			initProbs(this.distSpecial[i]);
		}

		initProbs(this.distAlign);
	}
}

export abstract class LiteralCoder {
	private readonly lc: number;
	private readonly literalPosMask: number;

	constructor(lc: number, lp: number) {
		this.lc = lc;
		this.literalPosMask = (1 << lp) - 1;
	}

	getSubcoderIndex(prevByte: number, pos: number): number {
		const low = prevByte >> (8 - this.lc);
		const high = (pos & this.literalPosMask) << this.lc;
		return low + high;
	}
}

export abstract class LiteralSubcoder {
	readonly probs: Probs = new Uint16Array(0x300);

	reset(): void {
		initProbs(this.probs);
	}
}

export abstract class LengthCoder {
	readonly choice: Probs = new Uint16Array(2);
	readonly low = newProbsArray(POS_STATES_MAX, LOW_SYMBOLS);
	readonly mid = newProbsArray(POS_STATES_MAX, MID_SYMBOLS);
	readonly high: Probs = new Uint16Array(HIGH_SYMBOLS);

	reset(): void {
		initProbs(this.choice);

		for (let i = 0; i < this.low.length; ++i) {
			initProbs(this.low[i]);
		}

		for (let i = 0; i < this.mid.length; ++i) {
			initProbs(this.mid[i]);
		}

		initProbs(this.high);
	}
}
