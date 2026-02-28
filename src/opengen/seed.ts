/**
 * OpenGen Seed System
 * 
 * Seeds can be:
 * - Numeric: "42", "1337"
 * - Word-based: "railway"
 * - Triplet (what3words-style): "signal.bridge.delay"
 * - Mixed: "freight42"
 * 
 * Same seed = same world. Always. Deterministic.
 * 
 * The seed produces a deterministic PRNG (xoshiro256**)
 * that drives all world generation decisions.
 */

// ============================================================
// WORD POOLS for triplet seed generation
// ============================================================

/** Railway-themed word pools for seed triplets */
const WORD_POOL_1 = [
    'signal', 'freight', 'express', 'local', 'branch', 'main', 'cross',
    'junction', 'terminal', 'loop', 'siding', 'yard', 'depot', 'tunnel',
    'bridge', 'viaduct', 'cutting', 'embankment', 'level', 'grade',
    'single', 'double', 'triple', 'quad', 'fast', 'slow', 'peak',
    'off', 'night', 'dawn', 'dusk', 'winter', 'summer', 'autumn',
    'spring', 'foggy', 'clear', 'rainy', 'cold', 'iron', 'steel',
    'copper', 'brass', 'silver', 'golden', 'red', 'green', 'blue',
    'northern', 'southern', 'eastern', 'western', 'central', 'outer',
    'inner', 'upper', 'lower', 'old', 'new', 'grand', 'royal', 'civic',
];

const WORD_POOL_2 = [
    'bridge', 'north', 'south', 'east', 'west', 'hill', 'valley',
    'river', 'lake', 'ford', 'port', 'gate', 'park', 'green',
    'wood', 'field', 'heath', 'marsh', 'moor', 'dale', 'glen',
    'bay', 'cove', 'point', 'cape', 'rock', 'stone', 'cliff',
    'tower', 'castle', 'church', 'abbey', 'mill', 'farm', 'hall',
    'court', 'square', 'circus', 'cross', 'lane', 'road', 'way',
    'street', 'avenue', 'drive', 'close', 'place', 'row', 'walk',
    'garden', 'terrace', 'yard', 'wharf', 'dock', 'quay', 'pier',
    'market', 'bank', 'works', 'forge', 'kiln', 'mine', 'quarry',
];

const WORD_POOL_3 = [
    'delay', 'locked', 'clear', 'danger', 'caution', 'proceed',
    'stop', 'wait', 'ready', 'set', 'route', 'block', 'section',
    'switch', 'points', 'aspect', 'lamp', 'lever', 'frame', 'box',
    'panel', 'desk', 'board', 'cabin', 'office', 'room', 'seat',
    'wheel', 'rail', 'track', 'gauge', 'curve', 'grade', 'slope',
    'speed', 'brake', 'steam', 'diesel', 'spark', 'power', 'load',
    'cargo', 'coach', 'wagon', 'van', 'tank', 'flat', 'hopper',
    'bell', 'horn', 'whistle', 'lamp', 'flag', 'board', 'post',
    'dawn', 'dusk', 'night', 'shift', 'watch', 'turn', 'pass',
];

// ============================================================
// DETERMINISTIC PRNG — xoshiro256**
// ============================================================

/**
 * xoshiro256** PRNG — high quality, fast, deterministic.
 * Seeded from a 64-bit hash of the seed string.
 */
export class SeededRNG {
    private state: [number, number, number, number];

    constructor(seed: string) {
        // Hash the seed string to produce initial state
        const hash = this.hashSeed(seed);
        this.state = [
            hash[0] || 1,
            hash[1] || 2,
            hash[2] || 3,
            hash[3] || 4,
        ];
        // Warm up the generator
        for (let i = 0; i < 20; i++) this.next();
    }

    /**
     * Hash a string into 4 32-bit numbers using a variant of MurmurHash3
     */
    private hashSeed(seed: string): [number, number, number, number] {
        let h1 = 0xdeadbeef;
        let h2 = 0x41c6ce57;
        let h3 = 0x6b8b4567;
        let h4 = 0x9e3779b9;

        for (let i = 0; i < seed.length; i++) {
            const ch = seed.charCodeAt(i);
            h1 = Math.imul(h1 ^ ch, 0x85ebca6b);
            h2 = Math.imul(h2 ^ ch, 0xc2b2ae35);
            h3 = Math.imul(h3 ^ ch, 0x27d4eb2f);
            h4 = Math.imul(h4 ^ ch, 0x165667b1);
        }

        h1 = Math.imul(h1 ^ (h1 >>> 16), 0x85ebca6b);
        h2 = Math.imul(h2 ^ (h2 >>> 13), 0xc2b2ae35);
        h3 = Math.imul(h3 ^ (h3 >>> 16), 0x27d4eb2f);
        h4 = Math.imul(h4 ^ (h4 >>> 13), 0x165667b1);

        return [
            (h1 ^ h2 ^ h3 ^ h4) >>> 0,
            (h2 ^ h1) >>> 0,
            (h3 ^ h4) >>> 0,
            (h4 ^ h3 ^ h2) >>> 0,
        ];
    }

    /** Next random 32-bit unsigned integer */
    next(): number {
        const s = this.state;
        const result = (Math.imul(s[1] * 5, 1) << 7 | (Math.imul(s[1] * 5, 1) >>> 25)) * 9;

        const t = s[1] << 9;
        s[2] ^= s[0];
        s[3] ^= s[1];
        s[1] ^= s[2];
        s[0] ^= s[3];
        s[2] ^= t;
        s[3] = (s[3] << 11) | (s[3] >>> 21);

        return result >>> 0;
    }

    /** Random float in [0, 1) */
    float(): number {
        return this.next() / 0x100000000;
    }

    /** Random integer in [min, max] (inclusive) */
    int(min: number, max: number): number {
        return min + Math.floor(this.float() * (max - min + 1));
    }

    /** Random boolean with given probability of true */
    chance(probability: number): boolean {
        return this.float() < probability;
    }

    /** Pick a random element from an array */
    pick<T>(arr: T[]): T {
        return arr[this.int(0, arr.length - 1)];
    }

    /** Shuffle an array in place (Fisher-Yates) */
    shuffle<T>(arr: T[]): T[] {
        for (let i = arr.length - 1; i > 0; i--) {
            const j = this.int(0, i);
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    }

    /** Random float in [min, max) */
    range(min: number, max: number): number {
        return min + this.float() * (max - min);
    }

    /** Gaussian distribution (Box-Muller) */
    gaussian(mean: number = 0, stddev: number = 1): number {
        const u1 = this.float();
        const u2 = this.float();
        const z = Math.sqrt(-2 * Math.log(u1 || 0.0001)) * Math.cos(2 * Math.PI * u2);
        return mean + z * stddev;
    }
}

// ============================================================
// SEED PARSING & GENERATION
// ============================================================

export interface ParsedSeed {
    /** The original seed string */
    raw: string;
    /** Normalized seed for RNG */
    normalized: string;
    /** Display name (triplet or original) */
    displayName: string;
    /** Whether this is a triplet seed */
    isTriplet: boolean;
    /** The words if triplet */
    words?: [string, string, string];
}

/**
 * Parse a seed string into a normalized form.
 * Supports numeric, word, triplet, and mixed formats.
 */
export function parseSeed(input: string): ParsedSeed {
    const raw = input.trim();

    // Check if it's a triplet (word.word.word)
    const tripletMatch = raw.match(/^([a-z]+)\.([a-z]+)\.([a-z]+)$/i);
    if (tripletMatch) {
        const words: [string, string, string] = [
            tripletMatch[1].toLowerCase(),
            tripletMatch[2].toLowerCase(),
            tripletMatch[3].toLowerCase(),
        ];
        return {
            raw,
            normalized: words.join('.'),
            displayName: words.join('.'),
            isTriplet: true,
            words,
        };
    }

    // For any other seed, normalize to lowercase
    const normalized = raw.toLowerCase().replace(/\s+/g, '');

    return {
        raw,
        normalized,
        displayName: raw,
        isTriplet: false,
    };
}

/**
 * Generate a random triplet seed.
 * Uses crypto.getRandomValues for true randomness.
 */
export function generateRandomTriplet(): string {
    const getRandomIndex = (max: number): number => {
        if (typeof window !== 'undefined' && window.crypto) {
            const arr = new Uint32Array(1);
            window.crypto.getRandomValues(arr);
            return arr[0] % max;
        }
        return Math.floor(Math.random() * max);
    };

    const w1 = WORD_POOL_1[getRandomIndex(WORD_POOL_1.length)];
    const w2 = WORD_POOL_2[getRandomIndex(WORD_POOL_2.length)];
    const w3 = WORD_POOL_3[getRandomIndex(WORD_POOL_3.length)];

    return `${w1}.${w2}.${w3}`;
}

/**
 * Generate a human-readable triplet from a numeric seed.
 * Deterministic: same number always produces same triplet.
 */
export function numericToTriplet(num: number): string {
    const i1 = num % WORD_POOL_1.length;
    const i2 = Math.floor(num / WORD_POOL_1.length) % WORD_POOL_2.length;
    const i3 = Math.floor(num / (WORD_POOL_1.length * WORD_POOL_2.length)) % WORD_POOL_3.length;

    return `${WORD_POOL_1[i1]}.${WORD_POOL_2[i2]}.${WORD_POOL_3[i3]}`;
}

// ============================================================
// OPENGEN VERSIONING
// ============================================================

export const OPENGEN_VERSION = '2.0.0';

export interface OpenGenManifest {
    version: string;
    changelog: string[];
}

export const OPENGEN_CHANGELOG: OpenGenManifest = {
    version: OPENGEN_VERSION,
    changelog: [
        'v2.0.0 — Major update. Improved map generation, depots, 4-aspect signals, manual signaller controls.',
        'v1.0.0 — Initial OpenGen release. Procedural junction and station generation.',
    ],
};
