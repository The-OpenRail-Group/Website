'use client';

/**
 * OpenRail — Main Game Canvas Component
 * 
 * This is the primary game view. It owns:
 * - The HTML5 Canvas
 * - The simulation loop
 * - Input handling (mouse, keyboard, touch)
 * - State management
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { GameWorld, CameraState, Vec2, EntityId, Difficulty } from '../engine/types';
import { simulationTick, requestRoute, cancelRoute, dispatchERU, toggleSignalClear, togglePoints } from '../engine/simulation';
import { generateWorld } from '../opengen/generator';
import { Renderer } from '../renderer/canvas';
import styles from './GameCanvas.module.css';

interface GameCanvasProps {
    seed: string;
    difficulty: Difficulty;
    onBack: () => void;
}

export default function GameCanvas({ seed, difficulty, onBack }: GameCanvasProps) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const rendererRef = useRef<Renderer | null>(null);
    const worldRef = useRef<GameWorld | null>(null);
    const animFrameRef = useRef<number>(0);
    const lastTimeRef = useRef<number>(0);
    const isPausedRef = useRef<boolean>(false);

    // UI State
    const [selectedEntity, setSelectedEntity] = useState<{ type: string; id: EntityId } | null>(null);
    const [isPaused, setIsPaused] = useState(false);
    const [timeScale, setTimeScale] = useState(1);
    const [showExplainWhy, setShowExplainWhy] = useState(false);
    const [explainText, setExplainText] = useState('');
    const [notifications, setNotifications] = useState<string[]>([]);
    const [worldInfo, setWorldInfo] = useState<{
        time: number;
        score: number;
        trainCount: number;
        failureCount: number;
        delayMinutes: number;
    }>({ time: 0, score: 0, trainCount: 0, failureCount: 0, delayMinutes: 0 });

    // ──────────────────────────────────────────
    // INITIALIZATION
    // ──────────────────────────────────────────

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        // Generate world from seed
        const world = generateWorld(seed, difficulty);
        worldRef.current = world;

        // Initialize renderer
        const renderer = new Renderer(canvas);
        rendererRef.current = renderer;

        // Center camera on the world
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        world.nodes.forEach(node => {
            minX = Math.min(minX, node.position.x);
            maxX = Math.max(maxX, node.position.x);
            minY = Math.min(minY, node.position.y);
            maxY = Math.max(maxY, node.position.y);
        });

        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;
        const worldWidth = maxX - minX + 200;
        const worldHeight = maxY - minY + 200;
        const scaleX = canvas.clientWidth / worldWidth;
        const scaleY = canvas.clientHeight / worldHeight;
        const zoom = Math.min(scaleX, scaleY, 1.5);

        renderer.setCamera({
            center: { x: centerX, y: centerY },
            targetCenter: { x: centerX, y: centerY },
            zoom,
            targetZoom: zoom,
        });

        // Start game loop
        lastTimeRef.current = performance.now();
        const gameLoop = (timestamp: number) => {
            const dt = Math.min((timestamp - lastTimeRef.current) / 1000, 0.1); // Cap at 100ms
            lastTimeRef.current = timestamp;

            if (!isPausedRef.current && worldRef.current) {
                simulationTick(worldRef.current, dt);

                // Update UI info
                const w = worldRef.current;
                setWorldInfo({
                    time: w.time,
                    score: Math.floor(w.score),
                    trainCount: w.trains.size,
                    failureCount: Array.from(w.failures.values()).filter(f => !f.resolved).length,
                    delayMinutes: Math.floor(w.totalDelayMinutes),
                });
            }

            if (worldRef.current && rendererRef.current) {
                rendererRef.current.render(worldRef.current);
            }

            animFrameRef.current = requestAnimationFrame(gameLoop);
        };

        animFrameRef.current = requestAnimationFrame(gameLoop);

        return () => {
            cancelAnimationFrame(animFrameRef.current);
        };
    }, [seed, difficulty]);

    // Sync pause state
    useEffect(() => {
        isPausedRef.current = isPaused;
        if (worldRef.current) {
            worldRef.current.timeScale = isPaused ? 0 : timeScale;
        }
    }, [isPaused, timeScale]);

    // ──────────────────────────────────────────
    // INPUT HANDLING — MOUSE
    // ──────────────────────────────────────────

    const isDragging = useRef(false);
    const dragStart = useRef<Vec2>({ x: 0, y: 0 });
    const cameraDragStart = useRef<Vec2>({ x: 0, y: 0 });

    const handleMouseDown = useCallback((e: React.MouseEvent) => {
        isDragging.current = true;
        dragStart.current = { x: e.clientX, y: e.clientY };
        const cam = rendererRef.current?.getCamera();
        if (cam) {
            cameraDragStart.current = { x: cam.center.x, y: cam.center.y };
        }
    }, []);

    const handleMouseMove = useCallback((e: React.MouseEvent) => {
        if (!rendererRef.current || !worldRef.current) return;

        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const screenPos = { x: e.clientX - rect.left, y: e.clientY - rect.top };

        if (isDragging.current) {
            const dx = e.clientX - dragStart.current.x;
            const dy = e.clientY - dragStart.current.y;
            const cam = rendererRef.current.getCamera();

            rendererRef.current.setCamera({
                targetCenter: {
                    x: cameraDragStart.current.x - dx / cam.zoom,
                    y: cameraDragStart.current.y - dy / cam.zoom,
                },
            });
        } else {
            // Hover detection
            const hit = rendererRef.current.hitTest(worldRef.current, screenPos);
            rendererRef.current.setHoveredEntity(hit?.id || null);
            canvas.style.cursor = hit ? 'pointer' : 'grab';
        }
    }, []);

    const handleMouseUp = useCallback((e: React.MouseEvent) => {
        if (!rendererRef.current || !worldRef.current) return;

        const wasDragging = isDragging.current;
        isDragging.current = false;

        // Check if this was a click (not a drag)
        const dx = e.clientX - dragStart.current.x;
        const dy = e.clientY - dragStart.current.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < 5 && wasDragging) {
            // This was a click
            const canvas = canvasRef.current;
            if (!canvas) return;
            const rect = canvas.getBoundingClientRect();
            const screenPos = { x: e.clientX - rect.left, y: e.clientY - rect.top };

            const hit = rendererRef.current.hitTest(worldRef.current, screenPos);
            if (hit) {
                setSelectedEntity(hit);
                rendererRef.current.setSelectedEntity(hit.id);
                handleEntityClick(hit);
            } else {
                setSelectedEntity(null);
                rendererRef.current.setSelectedEntity(null);
                setShowExplainWhy(false);
            }
        }
    }, []);

    const handleWheel = useCallback((e: React.WheelEvent) => {
        if (!rendererRef.current) return;
        e.preventDefault();

        const cam = rendererRef.current.getCamera();
        const zoomDelta = e.deltaY > 0 ? 0.9 : 1.1;
        const newZoom = Math.max(0.2, Math.min(5, cam.targetZoom * zoomDelta));

        rendererRef.current.setCamera({ targetZoom: newZoom });
    }, []);

    // ──────────────────────────────────────────
    // INPUT HANDLING — TOUCH
    // ──────────────────────────────────────────

    const touchStartRef = useRef<{ x: number; y: number; time: number }>({ x: 0, y: 0, time: 0 });
    const pinchStartDist = useRef<number>(0);
    const pinchStartZoom = useRef<number>(1);

    const handleTouchStart = useCallback((e: React.TouchEvent) => {
        if (e.touches.length === 1) {
            const t = e.touches[0];
            touchStartRef.current = { x: t.clientX, y: t.clientY, time: Date.now() };
            isDragging.current = true;
            dragStart.current = { x: t.clientX, y: t.clientY };
            const cam = rendererRef.current?.getCamera();
            if (cam) cameraDragStart.current = { ...cam.center };
        } else if (e.touches.length === 2) {
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            pinchStartDist.current = Math.sqrt(dx * dx + dy * dy);
            const cam = rendererRef.current?.getCamera();
            if (cam) pinchStartZoom.current = cam.zoom;
        }
    }, []);

    const handleTouchMove = useCallback((e: React.TouchEvent) => {
        if (!rendererRef.current) return;

        if (e.touches.length === 1 && isDragging.current) {
            const t = e.touches[0];
            const dx = t.clientX - dragStart.current.x;
            const dy = t.clientY - dragStart.current.y;
            const cam = rendererRef.current.getCamera();

            rendererRef.current.setCamera({
                targetCenter: {
                    x: cameraDragStart.current.x - dx / cam.zoom,
                    y: cameraDragStart.current.y - dy / cam.zoom,
                },
            });
        } else if (e.touches.length === 2) {
            const dx = e.touches[0].clientX - e.touches[1].clientX;
            const dy = e.touches[0].clientY - e.touches[1].clientY;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const scale = dist / (pinchStartDist.current || 1);
            const newZoom = Math.max(0.2, Math.min(5, pinchStartZoom.current * scale));

            rendererRef.current.setCamera({ targetZoom: newZoom });
        }
    }, []);

    const handleTouchEnd = useCallback((e: React.TouchEvent) => {
        isDragging.current = false;

        // Check for tap (short touch without much movement)
        const elapsed = Date.now() - touchStartRef.current.time;
        if (elapsed < 300 && rendererRef.current && worldRef.current) {
            const canvas = canvasRef.current;
            if (!canvas) return;
            const rect = canvas.getBoundingClientRect();
            const screenPos = {
                x: touchStartRef.current.x - rect.left,
                y: touchStartRef.current.y - rect.top,
            };

            const hit = rendererRef.current.hitTest(worldRef.current, screenPos);
            if (hit) {
                setSelectedEntity(hit);
                rendererRef.current.setSelectedEntity(hit.id);
                handleEntityClick(hit);
            } else {
                setSelectedEntity(null);
                rendererRef.current.setSelectedEntity(null);
            }
        }
    }, []);

    // ──────────────────────────────────────────
    // INPUT HANDLING — KEYBOARD
    // ──────────────────────────────────────────

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            switch (e.key) {
                case ' ':
                    e.preventDefault();
                    setIsPaused(p => !p);
                    break;
                case '1':
                    setTimeScale(1);
                    break;
                case '2':
                    setTimeScale(2);
                    break;
                case '3':
                    setTimeScale(4);
                    break;
                case '4':
                    setTimeScale(8);
                    break;
                case 'Escape':
                    setSelectedEntity(null);
                    rendererRef.current?.setSelectedEntity(null);
                    setShowExplainWhy(false);
                    break;
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, []);

    // ──────────────────────────────────────────
    // ENTITY INTERACTION
    // ──────────────────────────────────────────

    const handleEntityClick = useCallback((hit: { type: string; id: EntityId }) => {
        if (!worldRef.current) return;
        const world = worldRef.current;

        switch (hit.type) {
            case 'signal': {
                const signal = world.signals.get(hit.id);
                if (!signal) break;

                const result = toggleSignalClear(world, signal.id);
                if (!result.success) {
                    addNotification(result.reason || 'Cannot control signal');
                    setExplainText(result.reason || 'Cannot control signal.');
                    setShowExplainWhy(true);
                }
                break;
            }
            case 'points': {
                const pts = world.points.get(hit.id);
                if (!pts) break;

                const result = togglePoints(world, pts.id);
                if (!result.success) {
                    addNotification(result.reason || 'Cannot switch points');
                    setExplainText(result.reason || 'Cannot switch points.');
                    setShowExplainWhy(true);
                } else {
                    addNotification(`Points set to ${pts.position}`);
                }
                break;
            }
        }
    }, []);

    const addNotification = useCallback((text: string) => {
        setNotifications(prev => [...prev.slice(-4), text]);
        setTimeout(() => {
            setNotifications(prev => prev.slice(1));
        }, 4000);
    }, []);

    const handleExplainWhy = useCallback(() => {
        if (!selectedEntity || !worldRef.current) return;
        const world = worldRef.current;

        let explanation = '';

        switch (selectedEntity.type) {
            case 'signal': {
                const signal = world.signals.get(selectedEntity.id);
                if (!signal) break;

                if (signal.failed) {
                    explanation = `This signal has failed and is stuck at ${signal.failedAspect}. An Engineering Response Unit (ERU) must be dispatched to repair it.`;
                } else if (signal.aspect === 'RED') {
                    const block = world.blocks.get(signal.protectedBlockId);
                    if (block?.state === 'OCCUPIED') {
                        explanation = `This signal is at RED because the track section ahead is occupied by a train. The signal will clear automatically when the train moves forward.`;
                    } else {
                        const hasSetRoute = signal.routeIds.some(rid => {
                            const route = world.routes.get(rid);
                            return route && route.state !== 'UNSET';
                        });
                        if (!hasSetRoute) {
                            explanation = `This signal is at RED because no route has been set through it. Click the signal to request a route.`;
                        } else {
                            explanation = `This signal is at RED. A route is in the process of being set.`;
                        }
                    }
                } else if (signal.aspect === 'YELLOW') {
                    explanation = `This signal is at YELLOW (Caution). The next signal ahead is at RED. Trains will slow down when approaching this signal.`;
                } else if (signal.aspect === 'DOUBLE_YELLOW') {
                    explanation = `This signal is at DOUBLE YELLOW (Preliminary Caution). The signal after next is at RED.`;
                } else {
                    explanation = `This signal is at GREEN (Clear). The route ahead is clear and trains may proceed at line speed.`;
                }
                break;
            }

            case 'train': {
                const train = world.trains.get(selectedEntity.id);
                if (!train) break;

                const segment = world.segments.get(train.position.segmentId);
                const station = segment?.stationId ? world.stations.get(segment.stationId) : null;

                explanation = `Train ${train.headcode} (${train.type.toLowerCase().replace('_', ' ')}).\n`;
                explanation += `Speed: ${(train.speed * 3.6).toFixed(0)} km/h\n`;
                explanation += `State: ${train.state.toLowerCase().replace(/_/g, ' ')}\n`;

                if (train.delay > 0) {
                    explanation += `Delay: ${Math.floor(train.delay / 60)} minutes ${Math.floor(train.delay % 60)} seconds late\n`;
                }

                if (station) {
                    explanation += `Location: ${station.name}`;
                }

                if (train.state === 'STALLED') {
                    explanation += `\n\nThis train has stalled and cannot move. Dispatch an ERU to investigate and repair.`;
                }
                break;
            }

            case 'points': {
                const pts = world.points.get(selectedEntity.id);
                if (!pts) break;

                if (pts.failed) {
                    explanation = `These points have failed in the ${pts.failedPosition} position. They cannot be moved until an ERU repairs them.`;
                } else if (pts.locked) {
                    explanation = `These points are locked in the ${pts.position} position by an active route. They cannot be changed until the route releases.`;
                } else {
                    explanation = `These points are set to ${pts.position}. They are free to move.`;
                }
                break;
            }

            default:
                explanation = 'Select a signal, train, or points for detailed information.';
        }

        setExplainText(explanation);
        setShowExplainWhy(true);
    }, [selectedEntity]);

    // ──────────────────────────────────────────
    // TIME DISPLAY
    // ──────────────────────────────────────────

    const formatTime = (seconds: number): string => {
        const h = Math.floor(seconds / 3600) % 24;
        const m = Math.floor((seconds % 3600) / 60);
        return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
    };

    // ──────────────────────────────────────────
    // RENDER
    // ──────────────────────────────────────────

    return (
        <div className={styles.gameContainer}>
            {/* Canvas */}
            <canvas
                ref={canvasRef}
                className={styles.canvas}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={() => { isDragging.current = false; }}
                onWheel={handleWheel}
                onTouchStart={handleTouchStart}
                onTouchMove={handleTouchMove}
                onTouchEnd={handleTouchEnd}
            />

            {/* Top Bar */}
            <div className={styles.topBar}>
                <button className={styles.backButton} onClick={onBack}>
                    ← Menu
                </button>

                <div className={styles.topCenter}>
                    <span className={styles.clock}>{formatTime(worldInfo.time)}</span>
                    <span className={styles.separator}>|</span>
                    <span className={styles.score}>Score: {worldInfo.score}</span>
                </div>

                <div className={styles.topRight}>
                    <span className={styles.trainCount}>🚆 {worldInfo.trainCount}</span>
                    {worldInfo.failureCount > 0 && (
                        <span className={styles.failureCount}>⚠ {worldInfo.failureCount}</span>
                    )}
                </div>
            </div>

            {/* Time Controls */}
            <div className={styles.timeControls}>
                <button
                    className={`${styles.timeButton} ${isPaused ? styles.active : ''}`}
                    onClick={() => setIsPaused(!isPaused)}
                    title="Pause (Space)"
                >
                    {isPaused ? '▶' : '⏸'}
                </button>
                {[1, 2, 4, 8].map(speed => (
                    <button
                        key={speed}
                        className={`${styles.timeButton} ${timeScale === speed && !isPaused ? styles.active : ''}`}
                        onClick={() => { setTimeScale(speed); setIsPaused(false); }}
                        title={`${speed}× speed`}
                    >
                        ×{speed}
                    </button>
                ))}
            </div>

            {/* Delay Indicator */}
            {worldInfo.delayMinutes > 0 && (
                <div className={styles.delayIndicator}>
                    <span className={styles.delayLabel}>Total Delay</span>
                    <span className={styles.delayValue}>{worldInfo.delayMinutes}m</span>
                </div>
            )}

            {/* Notifications */}
            <div className={styles.notifications}>
                {notifications.map((note, i) => (
                    <div key={i} className={styles.notification}>
                        {note}
                    </div>
                ))}
            </div>

            {/* Selected Entity Panel */}
            {selectedEntity && (
                <div className={styles.entityPanel}>
                    <div className={styles.entityPanelHeader}>
                        <span className={styles.entityType}>{selectedEntity.type.toUpperCase()}</span>
                        <button
                            className={styles.closeButton}
                            onClick={() => {
                                setSelectedEntity(null);
                                rendererRef.current?.setSelectedEntity(null);
                                setShowExplainWhy(false);
                            }}
                        >
                            ×
                        </button>
                    </div>

                    <div className={styles.entityPanelBody}>
                        {selectedEntity.type === 'train' && worldRef.current && (() => {
                            const train = worldRef.current.trains.get(selectedEntity.id);
                            if (!train) return null;
                            return (
                                <>
                                    <div className={styles.entityField}>
                                        <span className={styles.fieldLabel}>Headcode</span>
                                        <span className={styles.fieldValue} style={{ color: train.color }}>{train.headcode}</span>
                                    </div>
                                    <div className={styles.entityField}>
                                        <span className={styles.fieldLabel}>Type</span>
                                        <span className={styles.fieldValue}>{train.type.replace('_', ' ')}</span>
                                    </div>
                                    <div className={styles.entityField}>
                                        <span className={styles.fieldLabel}>Speed</span>
                                        <span className={styles.fieldValue}>{(train.speed * 3.6).toFixed(0)} km/h</span>
                                    </div>
                                    <div className={styles.entityField}>
                                        <span className={styles.fieldLabel}>State</span>
                                        <span className={styles.fieldValue}>{train.state.replace(/_/g, ' ')}</span>
                                    </div>
                                    {train.delay > 0 && (
                                        <div className={styles.entityField}>
                                            <span className={styles.fieldLabel}>Delay</span>
                                            <span className={styles.fieldValue} style={{ color: '#e57373' }}>
                                                +{Math.floor(train.delay / 60)}m
                                            </span>
                                        </div>
                                    )}
                                </>
                            );
                        })()}

                        {selectedEntity.type === 'signal' && worldRef.current && (() => {
                            const signal = worldRef.current.signals.get(selectedEntity.id);
                            if (!signal) return null;
                            return (
                                <>
                                    <div className={styles.entityField}>
                                        <span className={styles.fieldLabel}>Aspect</span>
                                        <span className={styles.fieldValue} style={{
                                            color: signal.aspect === 'RED' ? '#e53935' :
                                                (signal.aspect === 'YELLOW' || signal.aspect === 'DOUBLE_YELLOW') ? '#fdd835' : '#43a047'
                                        }}>
                                            {signal.aspect.replace('_', ' ')}
                                        </span>
                                    </div>
                                    <div className={styles.entityField}>
                                        <span className={styles.fieldLabel}>Routes</span>
                                        <span className={styles.fieldValue}>{signal.routeIds.length}</span>
                                    </div>
                                    {signal.failed && (
                                        <div className={styles.entityField}>
                                            <span className={styles.fieldLabel}>Status</span>
                                            <span className={styles.fieldValue} style={{ color: '#e53935' }}>FAILED</span>
                                        </div>
                                    )}
                                </>
                            );
                        })()}
                    </div>

                    <button className={styles.explainButton} onClick={handleExplainWhy}>
                        Explain Why
                    </button>
                </div>
            )}

            {/* Explain Why Panel */}
            {showExplainWhy && (
                <div className={styles.explainPanel}>
                    <div className={styles.explainHeader}>
                        <span>Explain Why</span>
                        <button className={styles.closeButton} onClick={() => setShowExplainWhy(false)}>×</button>
                    </div>
                    <div className={styles.explainBody}>
                        {explainText.split('\n').map((line, i) => (
                            <p key={i}>{line}</p>
                        ))}
                    </div>
                </div>
            )}

            {/* Paused Overlay */}
            {isPaused && (
                <div className={styles.pausedOverlay}>
                    <span className={styles.pausedText}>PAUSED</span>
                    <span className={styles.pausedHint}>Press SPACE to resume</span>
                </div>
            )}

            {/* Help hint */}
            <div className={styles.helpHint}>
                Click signal to set route · Scroll to zoom · Drag to pan · Space to pause · 1-4 for speed
            </div>
        </div>
    );
}
