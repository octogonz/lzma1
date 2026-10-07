/**
 * Normal LZMA encoder: "optimal parsing".
 *
 * Instead of deciding one symbol at a time, it looks ahead up to `OPTS`
 * bytes and computes the cheapest way to reach every position (like a
 * shortest-path search where the edge weights are symbol prices). The
 * cheapest path is then walked backwards and returned symbol by symbol.
 *
 * Ported from XZ for Java (0BSD), `src/org/tukaani/xz/lzma/LZMAEncoderNormal.java`
 * and `Optimum.java`, by Lasse Collin and Igor Pavlov.
 */

import type {
	LzEncoder,
	Matches,
} from "./lz-encoder.js";
import {
	MATCH_LEN_MAX,
	MATCH_LEN_MIN,
	REPS,
	stateAfterLiteral,
	stateAfterLongRep,
	stateAfterMatch,
	stateAfterShortRep,
} from "./lzma-coder.js";
import {
	LzmaEncoder,
	type LzmaEncoderConfig,
} from "./lzma-encoder.js";
import type { RangeEncoder } from "./range-encoder.js";

/** Maximum number of positions optimized at once. */
export const OPTS = 4096;
export const NORMAL_EXTRA_SIZE_BEFORE = OPTS;
export const NORMAL_EXTRA_SIZE_AFTER = OPTS;

const INFINITY_PRICE = 1 << 30;

/** The cheapest known way to arrive at one position. */
class Optimum {
	/** The state after arriving here; 0 is the value of a new `State`. */
	state = 0;
	readonly reps = new Int32Array(REPS);

	/** Cumulative price of arriving to this byte. */
	price = 0;

	optPrev = 0;
	backPrev = 0;
	prev1IsLiteral = false;

	hasPrev2 = false;
	optPrev2 = 0;
	backPrev2 = 0;

	/** Resets the price. */
	reset(): void {
		this.price = INFINITY_PRICE;
	}

	/** Sets to indicate one LZMA symbol (literal, rep, or match). */
	set1(newPrice: number, optCur: number, back: number): void {
		this.price = newPrice;
		this.optPrev = optCur;
		this.backPrev = back;
		this.prev1IsLiteral = false;
	}

	/** Sets to indicate two LZMA symbols of which the first one is a literal. */
	set2(newPrice: number, optCur: number, back: number): void {
		this.price = newPrice;
		this.optPrev = optCur + 1;
		this.backPrev = back;
		this.prev1IsLiteral = true;
		this.hasPrev2 = false;
	}

	/**
	 * Sets to indicate three LZMA symbols of which the second one
	 * is a literal.
	 */
	set3(newPrice: number, optCur: number, back2: number, len2: number, back: number): void {
		this.price = newPrice;
		this.optPrev = optCur + len2 + 1;
		this.backPrev = back;
		this.prev1IsLiteral = true;
		this.hasPrev2 = true;
		this.optPrev2 = optCur;
		this.backPrev2 = back2;
	}
}

export interface LzmaEncoderNormalConfig extends LzmaEncoderConfig {
	/**
	 * Number of positions to allocate, at most `OPTS`. When the input size
	 * is known, `inputSize + 2` is enough (contract adaptation; the
	 * Java code always allocates `OPTS`).
	 */
	optsSize: number;
}

export class LzmaEncoderNormal extends LzmaEncoder {
	private readonly opts: Optimum[];
	private optCur = 0;
	private optEnd = 0;

	private matches!: Matches;

	// These are fields solely to avoid allocating the objects again and
	// again on each function call.
	private readonly repLens = new Int32Array(REPS);

	/** State after the symbols being priced, as in the Java code. */
	private nextState = 0;

	constructor(rc: RangeEncoder, lz: LzEncoder, config: LzmaEncoderNormalConfig) {
		super(rc, lz, config);

		const optsSize = Math.min(config.optsSize, OPTS);
		this.opts = Array.from({ length: optsSize }, () => new Optimum());
	}

	override reset(): void {
		this.optCur = 0;
		this.optEnd = 0;
		super.reset();
	}

	/**
	 * Converts the opts array from backward indexes to forward indexes.
	 * Then it will be simple to get the next symbol from the array
	 * in later calls to `getNextSymbol()`.
	 */
	private convertOpts(): number {
		this.optEnd = this.optCur;

		let optPrev = this.opts[this.optCur].optPrev;

		do {
			const opt = this.opts[this.optCur];

			if (opt.prev1IsLiteral) {
				this.opts[optPrev].optPrev = this.optCur;
				this.opts[optPrev].backPrev = -1;
				this.optCur = optPrev--;

				if (opt.hasPrev2) {
					this.opts[optPrev].optPrev = optPrev + 1;
					this.opts[optPrev].backPrev = opt.backPrev2;
					this.optCur = optPrev;
					optPrev = opt.optPrev2;
				}
			}

			const temp = this.opts[optPrev].optPrev;
			this.opts[optPrev].optPrev = this.optCur;
			this.optCur = optPrev;
			optPrev = temp;
		} while (this.optCur > 0);

		this.optCur = this.opts[0].optPrev;
		this.back = this.opts[this.optCur].backPrev;
		return this.optCur;
	}

	protected getNextSymbol(): number {
		// If there are pending symbols from an earlier call to this
		// function, return those symbols first.
		if (this.optCur < this.optEnd) {
			const len = this.opts[this.optCur].optPrev - this.optCur;
			this.optCur = this.opts[this.optCur].optPrev;
			this.back = this.opts[this.optCur].backPrev;
			return len;
		}

		this.optCur = 0;
		this.optEnd = 0;
		this.back = -1;

		if (this.readAhead === -1) {
			this.matches = this.getMatches();
		}

		// Get the number of bytes available in the dictionary, but
		// not more than the maximum match length. If there aren't
		// enough bytes remaining to encode a match at all, return
		// immediately to encode this byte as a literal.
		let avail = Math.min(this.lz.getAvail(), MATCH_LEN_MAX);
		if (avail < MATCH_LEN_MIN) {
			return 1;
		}

		// Get the lengths of repeated matches.
		let repBest = 0;
		for (let rep = 0; rep < REPS; ++rep) {
			this.repLens[rep] = this.lz.getMatchLen(0, this.reps[rep], avail);

			if (this.repLens[rep] < MATCH_LEN_MIN) {
				this.repLens[rep] = 0;
				continue;
			}

			if (this.repLens[rep] > this.repLens[repBest]) {
				repBest = rep;
			}
		}

		// Return if the best repeated match is at least niceLen bytes long.
		if (this.repLens[repBest] >= this.niceLen) {
			this.back = repBest;
			this.skip(this.repLens[repBest] - 1);
			return this.repLens[repBest];
		}

		// Initialize mainLen and mainDist to the longest match found
		// by the match finder.
		let mainLen = 0;
		let mainDist = 0;
		if (this.matches.count > 0) {
			mainLen = this.matches.len[this.matches.count - 1];
			mainDist = this.matches.dist[this.matches.count - 1];

			// Return if it is at least niceLen bytes long.
			if (mainLen >= this.niceLen) {
				this.back = mainDist + REPS;
				this.skip(mainLen - 1);
				return mainLen;
			}
		}

		const curByte = this.lz.getByte(0);
		const matchByte = this.lz.getByte(this.reps[0] + 1);

		// If the match finder found no matches and this byte cannot be
		// encoded as a repeated match (short or long), we must be return
		// to have the byte encoded as a literal.
		if (mainLen < MATCH_LEN_MIN && curByte !== matchByte && this.repLens[repBest] < MATCH_LEN_MIN) {
			return 1;
		}

		let pos = this.lz.getPos();
		let posState = pos & this.posMask;

		// Calculate the price of encoding the current byte as a literal.
		{
			const prevByte = this.lz.getByte(1);
			const literalPrice = this.literalEncoder.getPrice(curByte, matchByte, prevByte, pos, this.state.get());
			this.opts[1].set1(literalPrice, 0, -1);
		}

		let anyMatchPrice = this.getAnyMatchPrice(this.state.get(), posState);
		let anyRepPrice = this.getAnyRepPrice(anyMatchPrice, this.state.get());

		// If it is possible to encode this byte as a short rep, see if
		// it is cheaper than encoding it as a literal.
		if (matchByte === curByte) {
			const shortRepPrice = this.getShortRepPrice(anyRepPrice, this.state.get(), posState);
			if (shortRepPrice < this.opts[1].price) {
				this.opts[1].set1(shortRepPrice, 0, 0);
			}
		}

		// Return if there is neither normal nor long repeated match. Use
		// a short match instead of a literal if is is possible and cheaper.
		this.optEnd = Math.max(mainLen, this.repLens[repBest]);
		if (this.optEnd < MATCH_LEN_MIN) {
			this.back = this.opts[1].backPrev;
			return 1;
		}

		// Update the lookup tables for distances and lengths before using
		// those price calculation functions. (The price function above
		// don't need these tables.)
		this.updatePrices();

		// Initialize the state and reps of this position in opts[].
		// updateOptStateAndReps() will need these to get the new
		// state and reps for the next byte.
		this.opts[0].state = this.state.get();
		this.opts[0].reps.set(this.reps);

		// Initialize the prices for latter opts that will be used below.
		for (let i = this.optEnd; i >= MATCH_LEN_MIN; --i) {
			this.opts[i].reset();
		}

		// Calculate the prices of repeated matches of all lengths.
		for (let rep = 0; rep < REPS; ++rep) {
			let repLen = this.repLens[rep];
			if (repLen < MATCH_LEN_MIN) {
				continue;
			}

			const longRepPrice = this.getLongRepPrice(anyRepPrice, rep, this.state.get(), posState);
			do {
				const price = longRepPrice + this.repLenEncoder.getPrice(repLen, posState);
				if (price < this.opts[repLen].price) {
					this.opts[repLen].set1(price, 0, rep);
				}
			} while (--repLen >= MATCH_LEN_MIN);
		}

		// Calculate the prices of normal matches that are longer than rep0.
		{
			let len = Math.max(this.repLens[0] + 1, MATCH_LEN_MIN);
			if (len <= mainLen) {
				const normalMatchPrice = this.getNormalMatchPrice(anyMatchPrice, this.state.get());

				// Set i to the index of the shortest match that is
				// at least len bytes long.
				let i = 0;
				while (len > this.matches.len[i]) {
					++i;
				}

				while (true) {
					const dist = this.matches.dist[i];
					const price = this.getMatchAndLenPrice(normalMatchPrice, dist, len, posState);
					if (price < this.opts[len].price) {
						this.opts[len].set1(price, 0, dist + REPS);
					}

					if (len === this.matches.len[i]) {
						if (++i === this.matches.count) {
							break;
						}
					}

					++len;
				}
			}
		}

		avail = Math.min(this.lz.getAvail(), OPTS - 1);

		// Get matches for later bytes and optimize the use of LZMA symbols
		// by calculating the prices and picking the cheapest symbol
		// combinations.
		while (++this.optCur < this.optEnd) {
			this.matches = this.getMatches();
			if (this.matches.count > 0 && this.matches.len[this.matches.count - 1] >= this.niceLen) {
				break;
			}

			--avail;
			++pos;
			posState = pos & this.posMask;

			this.updateOptStateAndReps();
			anyMatchPrice = this.opts[this.optCur].price
				+ this.getAnyMatchPrice(this.opts[this.optCur].state, posState);
			anyRepPrice = this.getAnyRepPrice(anyMatchPrice, this.opts[this.optCur].state);

			this.calc1BytePrices(pos, posState, avail, anyRepPrice);

			if (avail >= MATCH_LEN_MIN) {
				const startLen = this.calcLongRepPrices(pos, posState, avail, anyRepPrice);
				if (this.matches.count > 0) {
					this.calcNormalMatchPrices(pos, posState, avail, anyMatchPrice, startLen);
				}
			}
		}

		return this.convertOpts();
	}

	/** Updates the state and reps for the current byte in the opts array. */
	private updateOptStateAndReps(): void {
		let optPrev = this.opts[this.optCur].optPrev;

		if (this.opts[this.optCur].prev1IsLiteral) {
			--optPrev;

			if (this.opts[this.optCur].hasPrev2) {
				this.opts[this.optCur].state = this.opts[this.opts[this.optCur].optPrev2].state;
				if (this.opts[this.optCur].backPrev2 < REPS) {
					this.opts[this.optCur].state = stateAfterLongRep(this.opts[this.optCur].state);
				} else {
					this.opts[this.optCur].state = stateAfterMatch(this.opts[this.optCur].state);
				}
			} else {
				this.opts[this.optCur].state = this.opts[optPrev].state;
			}

			this.opts[this.optCur].state = stateAfterLiteral(this.opts[this.optCur].state);
		} else {
			this.opts[this.optCur].state = this.opts[optPrev].state;
		}

		if (optPrev === this.optCur - 1) {
			// Must be either a short rep or a literal.
			if (this.opts[this.optCur].backPrev === 0) {
				this.opts[this.optCur].state = stateAfterShortRep(this.opts[this.optCur].state);
			} else {
				this.opts[this.optCur].state = stateAfterLiteral(this.opts[this.optCur].state);
			}

			this.opts[this.optCur].reps.set(this.opts[optPrev].reps);
		} else {
			let back: number;
			if (this.opts[this.optCur].prev1IsLiteral && this.opts[this.optCur].hasPrev2) {
				optPrev = this.opts[this.optCur].optPrev2;
				back = this.opts[this.optCur].backPrev2;
				this.opts[this.optCur].state = stateAfterLongRep(this.opts[this.optCur].state);
			} else {
				back = this.opts[this.optCur].backPrev;
				if (back < REPS) {
					this.opts[this.optCur].state = stateAfterLongRep(this.opts[this.optCur].state);
				} else {
					this.opts[this.optCur].state = stateAfterMatch(this.opts[this.optCur].state);
				}
			}

			if (back < REPS) {
				this.opts[this.optCur].reps[0] = this.opts[optPrev].reps[back];

				let rep: number;
				for (rep = 1; rep <= back; ++rep) {
					this.opts[this.optCur].reps[rep] = this.opts[optPrev].reps[rep - 1];
				}

				for (; rep < REPS; ++rep) {
					this.opts[this.optCur].reps[rep] = this.opts[optPrev].reps[rep];
				}
			} else {
				this.opts[this.optCur].reps[0] = back - REPS;
				this.opts[this.optCur].reps.set(this.opts[optPrev].reps.subarray(0, REPS - 1), 1);
			}
		}
	}

	/** Calculates prices of a literal, a short rep, and literal + rep0. */
	private calc1BytePrices(pos: number, posState: number, avail: number, anyRepPrice: number): void {
		// This will be set to true if using a literal or a short rep.
		let nextIsByte = false;

		const curByte = this.lz.getByte(0);
		const matchByte = this.lz.getByte(this.opts[this.optCur].reps[0] + 1);

		// Try a literal.
		const literalPrice = this.opts[this.optCur].price
			+ this.literalEncoder.getPrice(curByte, matchByte, this.lz.getByte(1), pos, this.opts[this.optCur].state);
		if (literalPrice < this.opts[this.optCur + 1].price) {
			this.opts[this.optCur + 1].set1(literalPrice, this.optCur, -1);
			nextIsByte = true;
		}

		// Try a short rep.
		if (
			matchByte === curByte
			&& (this.opts[this.optCur + 1].optPrev === this.optCur
				|| this.opts[this.optCur + 1].backPrev !== 0)
		) {
			const shortRepPrice = this.getShortRepPrice(anyRepPrice, this.opts[this.optCur].state, posState);
			if (shortRepPrice <= this.opts[this.optCur + 1].price) {
				this.opts[this.optCur + 1].set1(shortRepPrice, this.optCur, 0);
				nextIsByte = true;
			}
		}

		// If neither a literal nor a short rep was the cheapest choice,
		// try literal + long rep0.
		if (!nextIsByte && matchByte !== curByte && avail > MATCH_LEN_MIN) {
			const lenLimit = Math.min(this.niceLen, avail - 1);
			const len = this.lz.getMatchLen(1, this.opts[this.optCur].reps[0], lenLimit);

			if (len >= MATCH_LEN_MIN) {
				this.nextState = this.opts[this.optCur].state;
				this.nextState = stateAfterLiteral(this.nextState);
				const nextPosState = (pos + 1) & this.posMask;
				const price = literalPrice
					+ this.getLongRepAndLenPrice(0, len, this.nextState, nextPosState);

				const i = this.optCur + 1 + len;
				while (this.optEnd < i) {
					this.opts[++this.optEnd].reset();
				}

				if (price < this.opts[i].price) {
					this.opts[i].set2(price, this.optCur, 0);
				}
			}
		}
	}

	/**
	 * Calculates prices of long rep and long rep + literal + rep0.
	 */
	private calcLongRepPrices(pos: number, posState: number, avail: number, anyRepPrice: number): number {
		let startLen = MATCH_LEN_MIN;
		const lenLimit = Math.min(avail, this.niceLen);

		for (let rep = 0; rep < REPS; ++rep) {
			const len = this.lz.getMatchLen(0, this.opts[this.optCur].reps[rep], lenLimit);
			if (len < MATCH_LEN_MIN) {
				continue;
			}

			while (this.optEnd < this.optCur + len) {
				this.opts[++this.optEnd].reset();
			}

			const longRepPrice = this.getLongRepPrice(anyRepPrice, rep, this.opts[this.optCur].state, posState);

			for (let i = len; i >= MATCH_LEN_MIN; --i) {
				const price = longRepPrice
					+ this.repLenEncoder.getPrice(i, posState);
				if (price < this.opts[this.optCur + i].price) {
					this.opts[this.optCur + i].set1(price, this.optCur, rep);
				}
			}

			if (rep === 0) {
				startLen = len + 1;
			}

			let len2Limit = avail - len - 1;
			if (len2Limit < MATCH_LEN_MIN) {
				continue;
			}

			if (len2Limit > this.niceLen) {
				len2Limit = this.niceLen;
			}

			const len2 = this.lz.getMatchLen(len + 1, this.opts[this.optCur].reps[rep], len2Limit);

			if (len2 >= MATCH_LEN_MIN) {
				// Rep
				let price = longRepPrice
					+ this.repLenEncoder.getPrice(len, posState);
				this.nextState = this.opts[this.optCur].state;
				this.nextState = stateAfterLongRep(this.nextState);

				// Literal
				const curByte = this.lz.getByteAt(len, 0);
				const matchByte = this.lz.getByte(0); // lz.getByteAt(len, len)
				const prevByte = this.lz.getByteAt(len, 1);
				price += this.literalEncoder.getPrice(curByte, matchByte, prevByte, pos + len, this.nextState);
				this.nextState = stateAfterLiteral(this.nextState);

				// Rep0
				const nextPosState = (pos + len + 1) & this.posMask;
				price += this.getLongRepAndLenPrice(0, len2, this.nextState, nextPosState);

				const i = this.optCur + len + 1 + len2;
				while (this.optEnd < i) {
					this.opts[++this.optEnd].reset();
				}

				if (price < this.opts[i].price) {
					this.opts[i].set3(price, this.optCur, rep, len, 0);
				}
			}
		}

		return startLen;
	}

	/**
	 * Calculates prices of a normal match and normal match + literal + rep0.
	 */
	private calcNormalMatchPrices(pos: number, posState: number, avail: number, anyMatchPrice: number, startLen: number): void {
		// If the longest match is so long that it would not fit into
		// the opts array, shorten the matches.
		if (this.matches.len[this.matches.count - 1] > avail) {
			this.matches.count = 0;
			while (this.matches.len[this.matches.count] < avail) {
				++this.matches.count;
			}

			this.matches.len[this.matches.count++] = avail;
		}

		if (this.matches.len[this.matches.count - 1] < startLen) {
			return;
		}

		while (this.optEnd < this.optCur + this.matches.len[this.matches.count - 1]) {
			this.opts[++this.optEnd].reset();
		}

		const normalMatchPrice = this.getNormalMatchPrice(anyMatchPrice, this.opts[this.optCur].state);

		let match = 0;
		while (startLen > this.matches.len[match]) {
			++match;
		}

		for (let len = startLen;; ++len) {
			const dist = this.matches.dist[match];

			// Calculate the price of a match of len bytes from the nearest
			// possible distance.
			const matchAndLenPrice = this.getMatchAndLenPrice(normalMatchPrice, dist, len, posState);
			if (matchAndLenPrice < this.opts[this.optCur + len].price) {
				this.opts[this.optCur + len].set1(matchAndLenPrice, this.optCur, dist + REPS);
			}

			if (len !== this.matches.len[match]) {
				continue;
			}

			// Try match + literal + rep0. First get the length of the rep0.
			let len2Limit = avail - len - 1;
			if (len2Limit >= MATCH_LEN_MIN) {
				if (len2Limit > this.niceLen) {
					len2Limit = this.niceLen;
				}

				const len2 = this.lz.getMatchLen(len + 1, dist, len2Limit);
				if (len2 >= MATCH_LEN_MIN) {
					this.nextState = this.opts[this.optCur].state;
					this.nextState = stateAfterMatch(this.nextState);

					// Literal
					const curByte = this.lz.getByteAt(len, 0);
					const matchByte = this.lz.getByte(0); // lz.getByteAt(len, len)
					const prevByte = this.lz.getByteAt(len, 1);
					let price = matchAndLenPrice
						+ this.literalEncoder.getPrice(curByte, matchByte, prevByte, pos + len, this.nextState);
					this.nextState = stateAfterLiteral(this.nextState);

					// Rep0
					const nextPosState = (pos + len + 1) & this.posMask;
					price += this.getLongRepAndLenPrice(0, len2, this.nextState, nextPosState);

					const i = this.optCur + len + 1 + len2;
					while (this.optEnd < i) {
						this.opts[++this.optEnd].reset();
					}

					if (price < this.opts[i].price) {
						this.opts[i].set3(price, this.optCur, dist + REPS, len, 0);
					}
				}
			}

			if (++match === this.matches.count) {
				break;
			}
		}
	}
}
