'use client';

/**
 * OpenRail — Seed Input Component
 * 
 * A beautiful, focused interface for entering or generating seeds.
 * This is the gateway to every OpenRail world.
 * 
 * Supports:
 * - Typing any seed (numeric, word, mixed)
 * - Generating random triplet seeds (what3words-style)
 * - Visual preview of the seed's "fingerprint"
 * - Seed history
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { generateRandomTriplet, parseSeed, SeededRNG, OPENGEN_VERSION } from '../opengen/seed';
import styles from './SeedInput.module.css';

interface SeedInputProps {
    onStart: (seed: string) => void;
}

export default function SeedInput({ onStart }: SeedInputProps) {
    const [seed, setSeed] = useState('');
    const [displaySeed, setDisplaySeed] = useState('');
    const [isGenerating, setIsGenerating] = useState(false);
    const [fingerprint, setFingerprint] = useState<number[]>([]);
    const inputRef = useRef<HTMLInputElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);

    // Auto-focus
    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    // Generate fingerprint visualization when seed changes
    useEffect(() => {
        if (!seed) {
            setFingerprint([]);
            return;
        }

        const rng = new SeededRNG(seed);
        const fp: number[] = [];
        for (let i = 0; i < 64; i++) {
            fp.push(rng.float());
        }
        setFingerprint(fp);

        // Draw fingerprint on canvas
        drawFingerprint(fp);
    }, [seed]);

    const drawFingerprint = useCallback((fp: number[]) => {
        const canvas = canvasRef.current;
        if (!canvas || fp.length === 0) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const dpr = window.devicePixelRatio || 1;
        canvas.width = 200 * dpr;
        canvas.height = 80 * dpr;
        ctx.scale(dpr, dpr);

        ctx.clearRect(0, 0, 200, 80);

        // Draw abstract pattern from seed fingerprint
        const barWidth = 200 / fp.length;

        for (let i = 0; i < fp.length; i++) {
            const value = fp[i];
            const height = value * 60 + 5;
            const x = i * barWidth;

            // Color based on value — railway signal palette
            const hue = 180 + value * 40; // Cyan-blue range
            const lightness = 15 + value * 25;
            ctx.fillStyle = `hsl(${hue}, 40%, ${lightness}%)`;

            ctx.fillRect(x, 80 - height, barWidth - 0.5, height);
        }

        // Subtle glow overlay
        const gradient = ctx.createLinearGradient(0, 0, 200, 0);
        gradient.addColorStop(0, 'rgba(79, 195, 247, 0.02)');
        gradient.addColorStop(0.5, 'rgba(79, 195, 247, 0.05)');
        gradient.addColorStop(1, 'rgba(79, 195, 247, 0.02)');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, 200, 80);
    }, []);

    const handleRandomize = useCallback(() => {
        setIsGenerating(true);

        // Cascade through a few random seeds for visual effect
        let count = 0;
        const interval = setInterval(() => {
            const triplet = generateRandomTriplet();
            setDisplaySeed(triplet);
            count++;

            if (count >= 6) {
                clearInterval(interval);
                const finalTriplet = generateRandomTriplet();
                setSeed(finalTriplet);
                setDisplaySeed(finalTriplet);
                setIsGenerating(false);
            }
        }, 80);
    }, []);

    const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const val = e.target.value;
        setSeed(val);
        setDisplaySeed(val);
    }, []);

    const handleStart = useCallback(() => {
        if (seed.trim()) {
            onStart(seed.trim());
        }
    }, [seed, onStart]);

    const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && seed.trim()) {
            onStart(seed.trim());
        }
    }, [seed, onStart]);

    const parsed = seed ? parseSeed(seed) : null;

    return (
        <div className={styles.container}>
            <div className={styles.card}>
                {/* Seed fingerprint visualization */}
                <div className={styles.fingerprintContainer}>
                    <canvas ref={canvasRef} className={styles.fingerprint} />
                    {!seed && <span className={styles.fingerprintPlaceholder}>Enter a seed to see its fingerprint</span>}
                </div>

                {/* Input */}
                <div className={styles.inputGroup}>
                    <input
                        ref={inputRef}
                        type="text"
                        className={styles.seedInput}
                        value={displaySeed}
                        onChange={handleInputChange}
                        onKeyDown={handleKeyDown}
                        placeholder="signal.bridge.delay"
                        spellCheck={false}
                        autoComplete="off"
                    />
                </div>

                {/* Seed info */}
                {parsed && (
                    <div className={styles.seedInfo}>
                        <span className={styles.seedType}>
                            {parsed.isTriplet ? '● Triplet Seed' : '● Custom Seed'}
                        </span>
                        <span className={styles.seedNormalized}>
                            {parsed.normalized}
                        </span>
                    </div>
                )}

                {/* Actions */}
                <div className={styles.actions}>
                    <button
                        className={styles.randomButton}
                        onClick={handleRandomize}
                        disabled={isGenerating}
                    >
                        {isGenerating ? (
                            <span className={styles.generating}>Generating...</span>
                        ) : (
                            <>
                                <span className={styles.diceIcon}>⚄</span>
                                Random Seed
                            </>
                        )}
                    </button>

                    <button
                        className={styles.startButton}
                        onClick={handleStart}
                        disabled={!seed.trim()}
                    >
                        Start Simulation →
                    </button>
                </div>

                {/* OpenGen version */}
                <div className={styles.version}>
                    OpenGen {OPENGEN_VERSION}
                </div>
            </div>
        </div>
    );
}
