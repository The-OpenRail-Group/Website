'use client';

import React, { useState } from 'react';
import SeedInput from '../components/SeedInput';
import GameCanvas from '../components/GameCanvas';
import { Difficulty } from '../engine/types';

export default function Home() {
  const [gameState, setGameState] = useState<'menu' | 'playing'>('menu');
  const [seed, setSeed] = useState<string>('');
  const [difficulty, setDifficulty] = useState<Difficulty>(Difficulty.NORMAL);

  const handleStart = (selectedSeed: string) => {
    setSeed(selectedSeed);
    setGameState('playing');
  };

  const handleBack = () => {
    setGameState('menu');
  };

  return (
    <main style={{ width: '100vw', height: '100vh', overflow: 'hidden', background: '#050505' }}>
      {gameState === 'menu' ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', paddingTop: '10vh' }}>
          <div style={{ marginBottom: '40px', textAlign: 'center' }}>
            <h1 style={{ color: '#fff', fontSize: '3rem', fontWeight: 300, letterSpacing: '4px', marginBottom: '8px', fontFamily: '"Inter", sans-serif' }}>
              OPEN<span style={{ color: '#4FC3F7', fontWeight: 600 }}>RAIL</span>
            </h1>
            <p style={{ color: '#888', fontSize: '1rem', letterSpacing: '1px', fontFamily: '"Inter", sans-serif' }}>
              RAILWAY SIGNALLING SIMULATION
            </p>
          </div>

          <div style={{ marginBottom: '20px', display: 'flex', gap: '10px' }}>
            <button
              onClick={() => setDifficulty(Difficulty.EASY)}
              style={{
                background: difficulty === Difficulty.EASY ? 'rgba(79, 195, 247, 0.1)' : 'transparent',
                border: `1px solid ${difficulty === Difficulty.EASY ? '#4FC3F7' : '#333'}`,
                color: difficulty === Difficulty.EASY ? '#4FC3F7' : '#888',
                padding: '8px 16px', borderRadius: '4px', cursor: 'pointer', fontFamily: '"Inter", sans-serif'
              }}
            >
              Easy
            </button>
            <button
              onClick={() => setDifficulty(Difficulty.NORMAL)}
              style={{
                background: difficulty === Difficulty.NORMAL ? 'rgba(79, 195, 247, 0.1)' : 'transparent',
                border: `1px solid ${difficulty === Difficulty.NORMAL ? '#4FC3F7' : '#333'}`,
                color: difficulty === Difficulty.NORMAL ? '#4FC3F7' : '#888',
                padding: '8px 16px', borderRadius: '4px', cursor: 'pointer', fontFamily: '"Inter", sans-serif'
              }}
            >
              Normal
            </button>
            <button
              onClick={() => setDifficulty(Difficulty.HARD)}
              style={{
                background: difficulty === Difficulty.HARD ? 'rgba(79, 195, 247, 0.1)' : 'transparent',
                border: `1px solid ${difficulty === Difficulty.HARD ? '#4FC3F7' : '#333'}`,
                color: difficulty === Difficulty.HARD ? '#4FC3F7' : '#888',
                padding: '8px 16px', borderRadius: '4px', cursor: 'pointer', fontFamily: '"Inter", sans-serif'
              }}
            >
              Hard
            </button>
          </div>

          <SeedInput onStart={handleStart} />
        </div>
      ) : (
        <GameCanvas seed={seed} difficulty={difficulty} onBack={handleBack} />
      )}
    </main>
  );
}
