/**
 * OpenRail Canvas Renderer
 * 
 * Renders the railway network onto an HTML5 Canvas.
 * 
 * Visual Style:
 * 🖤 Massive black background
 * ➖ Thin lines = track
 * ▭ Rectangles = trains (moving smoothly)
 * ● / | = signals
 * ⤴ = points indicators
 * 
 * Think real railway control centres, not games.
 * Minimal. Professional. Calm.
 */

import {
    GameWorld, CameraState, Vec2, Signal, Train, Points, Station,
    SignalAspect, PointsPosition, BlockState, TrainState, RouteState,
    TrackSegment, Block, EntityId,
} from '../engine/types';

// ============================================================
// COLORS — Control Panel Palette
// ============================================================

const COLORS = {
    background: '#0a0a0a',

    // Track
    trackNormal: '#2a2a2a',
    trackActive: '#3a3a3a',
    trackOccupied: '#1a3650',
    trackPlatform: '#2a3a2a',
    trackFailed: '#3a1a1a',

    // Signals
    signalRed: '#e53935',
    signalYellow: '#fdd835',
    signalGreen: '#43a047',
    signalOff: '#333333',
    signalPost: '#555555',

    // Train colors are per-train (assigned during generation)
    trainOutline: '#ffffff20',

    // Points
    pointsNormal: '#4a4a4a',
    pointsReverse: '#6a6a4a',
    pointsFailed: '#8a2a2a',
    pointsLocked: '#4a4a6a',

    // UI / Labels
    stationLabel: '#808080',
    stationPlatform: '#505050',
    headcode: '#cccccc',
    delay: '#e57373',
    onTime: '#43a047',

    // Selection
    selectionGlow: '#4FC3F7',
    hoverGlow: '#ffffff15',

    // Grid
    gridLine: '#111111',
    gridMajor: '#151515',

    // Route
    routeSet: '#2e7d32',
    routeRequested: '#f9a825',
};

// ============================================================
// RENDERER CLASS
// ============================================================

export class Renderer {
    private canvas: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D;
    private camera: CameraState;
    private animationFrame: number = 0;
    private hoveredEntity: EntityId | null = null;
    private selectedEntity: EntityId | null = null;

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Failed to get 2D context');
        this.ctx = ctx;

        this.camera = {
            center: { x: 600, y: 400 },
            zoom: 1.0,
            targetZoom: 1.0,
            targetCenter: { x: 600, y: 400 },
        };
    }

    // ──────────────────────────────────────────
    // PUBLIC API
    // ──────────────────────────────────────────

    setCamera(camera: Partial<CameraState>): void {
        Object.assign(this.camera, camera);
    }

    getCamera(): CameraState {
        return { ...this.camera };
    }

    setHoveredEntity(id: EntityId | null): void {
        this.hoveredEntity = id;
    }

    setSelectedEntity(id: EntityId | null): void {
        this.selectedEntity = id;
    }

    /**
     * Render the complete world state.
     */
    render(world: GameWorld): void {
        const { ctx, canvas } = this;
        const dpr = window.devicePixelRatio || 1;

        // Handle resize
        const displayWidth = canvas.clientWidth;
        const displayHeight = canvas.clientHeight;

        if (canvas.width !== displayWidth * dpr || canvas.height !== displayHeight * dpr) {
            canvas.width = displayWidth * dpr;
            canvas.height = displayHeight * dpr;
            ctx.scale(dpr, dpr);
        }

        // Smooth camera interpolation
        this.camera.center.x += (this.camera.targetCenter.x - this.camera.center.x) * 0.08;
        this.camera.center.y += (this.camera.targetCenter.y - this.camera.center.y) * 0.08;
        this.camera.zoom += (this.camera.targetZoom - this.camera.zoom) * 0.08;

        // Clear with dark background
        ctx.fillStyle = COLORS.background;
        ctx.fillRect(0, 0, displayWidth, displayHeight);

        // Draw subtle grid
        this.drawGrid(displayWidth, displayHeight);

        // Apply camera transform
        ctx.save();
        ctx.translate(displayWidth / 2, displayHeight / 2);
        ctx.scale(this.camera.zoom, this.camera.zoom);
        ctx.translate(-this.camera.center.x, -this.camera.center.y);

        // Render layers (back to front)
        this.renderBlocks(world);
        this.renderTracks(world);
        this.renderPoints(world);
        this.renderSignals(world);
        this.renderStations(world);
        this.renderTrains(world);
        this.renderRouteIndicators(world);

        ctx.restore();

        // Render HUD elements (screen space)
        this.renderScreenSpaceInfo(world, displayWidth, displayHeight);
    }

    // ──────────────────────────────────────────
    // COORDINATE TRANSFORMS
    // ──────────────────────────────────────────

    worldToScreen(worldPos: Vec2): Vec2 {
        const displayWidth = this.canvas.clientWidth;
        const displayHeight = this.canvas.clientHeight;
        return {
            x: (worldPos.x - this.camera.center.x) * this.camera.zoom + displayWidth / 2,
            y: (worldPos.y - this.camera.center.y) * this.camera.zoom + displayHeight / 2,
        };
    }

    screenToWorld(screenPos: Vec2): Vec2 {
        const displayWidth = this.canvas.clientWidth;
        const displayHeight = this.canvas.clientHeight;
        return {
            x: (screenPos.x - displayWidth / 2) / this.camera.zoom + this.camera.center.x,
            y: (screenPos.y - displayHeight / 2) / this.camera.zoom + this.camera.center.y,
        };
    }

    // ──────────────────────────────────────────
    // GRID
    // ──────────────────────────────────────────

    private drawGrid(width: number, height: number): void {
        const ctx = this.ctx;
        const gridSize = 50 * this.camera.zoom;

        if (gridSize < 10) return; // Don't render grid when zoomed out too far

        const offsetX = -(this.camera.center.x * this.camera.zoom - width / 2) % gridSize;
        const offsetY = -(this.camera.center.y * this.camera.zoom - height / 2) % gridSize;

        ctx.strokeStyle = COLORS.gridLine;
        ctx.lineWidth = 0.5;

        for (let x = offsetX; x < width; x += gridSize) {
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, height);
            ctx.stroke();
        }

        for (let y = offsetY; y < height; y += gridSize) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(width, y);
            ctx.stroke();
        }
    }

    // ──────────────────────────────────────────
    // BLOCKS (Track circuits — subtle indicators)
    // ──────────────────────────────────────────

    private renderBlocks(world: GameWorld): void {
        const ctx = this.ctx;

        world.blocks.forEach((block) => {
            const segment = world.segments.get(block.segmentId);
            if (!segment) return;

            const startNode = world.nodes.get(segment.startNodeId);
            const endNode = world.nodes.get(segment.endNodeId);
            if (!startNode || !endNode) return;

            const startPos = this.lerpPos(startNode.position, endNode.position, block.startT);
            const endPos = this.lerpPos(startNode.position, endNode.position, block.endT);

            // Only show block state on occupied or failed sections
            if (block.state === BlockState.OCCUPIED) {
                ctx.strokeStyle = COLORS.trackOccupied;
                ctx.lineWidth = 6;
                ctx.globalAlpha = 0.3;
                ctx.beginPath();
                ctx.moveTo(startPos.x, startPos.y);
                ctx.lineTo(endPos.x, endPos.y);
                ctx.stroke();
                ctx.globalAlpha = 1;
            } else if (block.failed) {
                ctx.strokeStyle = COLORS.trackFailed;
                ctx.lineWidth = 6;
                ctx.globalAlpha = 0.4;
                ctx.beginPath();
                ctx.moveTo(startPos.x, startPos.y);
                ctx.lineTo(endPos.x, endPos.y);
                ctx.stroke();
                ctx.globalAlpha = 1;
            }
        });
    }

    // ──────────────────────────────────────────
    // TRACKS
    // ──────────────────────────────────────────

    private renderTracks(world: GameWorld): void {
        const ctx = this.ctx;

        world.segments.forEach((segment) => {
            const startNode = world.nodes.get(segment.startNodeId);
            const endNode = world.nodes.get(segment.endNodeId);
            if (!startNode || !endNode) return;

            // Track color
            let color = COLORS.trackNormal;
            if (segment.isPlatform) {
                color = COLORS.trackPlatform;
            }

            // Check if any block on this segment is occupied
            let isOccupied = false;
            segment.blockIds.forEach(bid => {
                const block = world.blocks.get(bid);
                if (block && block.state === BlockState.OCCUPIED) isOccupied = true;
            });

            if (isOccupied) {
                color = COLORS.trackOccupied;
            }

            // Draw the track line
            ctx.strokeStyle = color;
            ctx.lineWidth = segment.isPlatform ? 3 : 2;
            ctx.lineCap = 'round';

            ctx.beginPath();
            ctx.moveTo(startNode.position.x, startNode.position.y);

            if (segment.waypoints.length > 0) {
                segment.waypoints.forEach(wp => {
                    ctx.lineTo(wp.x, wp.y);
                });
            }

            ctx.lineTo(endNode.position.x, endNode.position.y);
            ctx.stroke();

            // Platform edge indicator (thicker line alongside platform)
            if (segment.isPlatform) {
                ctx.strokeStyle = '#1a2a1a';
                ctx.lineWidth = 8;
                ctx.globalAlpha = 0.3;

                const dx = endNode.position.x - startNode.position.x;
                const dy = endNode.position.y - startNode.position.y;
                const len = Math.sqrt(dx * dx + dy * dy) || 1;
                const nx = -dy / len * 8; // Normal offset
                const ny = dx / len * 8;

                ctx.beginPath();
                ctx.moveTo(startNode.position.x + nx, startNode.position.y + ny);
                ctx.lineTo(endNode.position.x + nx, endNode.position.y + ny);
                ctx.stroke();
                ctx.globalAlpha = 1;
            }
        });
    }

    // ──────────────────────────────────────────
    // SIGNALS
    // ──────────────────────────────────────────

    private renderSignals(world: GameWorld): void {
        const ctx = this.ctx;

        world.signals.forEach((signal) => {
            const { position, aspect } = signal;

            // Signal post
            ctx.strokeStyle = COLORS.signalPost;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(position.x, position.y + 12);
            ctx.lineTo(position.x, position.y - 2);
            ctx.stroke();

            // Signal head (circle)
            const radius = 5;

            // Glow effect for active signals
            if (aspect !== SignalAspect.RED) {
                const glowColor = aspect === SignalAspect.GREEN ? COLORS.signalGreen : COLORS.signalYellow;
                ctx.beginPath();
                ctx.arc(position.x, position.y, radius + 4, 0, Math.PI * 2);
                ctx.fillStyle = glowColor;
                ctx.globalAlpha = 0.15;
                ctx.fill();
                ctx.globalAlpha = 1;
            }

            // Signal head fill
            ctx.beginPath();
            ctx.arc(position.x, position.y, radius, 0, Math.PI * 2);

            switch (aspect) {
                case SignalAspect.RED:
                    ctx.fillStyle = COLORS.signalRed;
                    break;
                case SignalAspect.YELLOW:
                    ctx.fillStyle = COLORS.signalYellow;
                    break;
                case SignalAspect.GREEN:
                    ctx.fillStyle = COLORS.signalGreen;
                    break;
            }
            ctx.fill();

            // Signal head outline
            ctx.strokeStyle = '#000';
            ctx.lineWidth = 1;
            ctx.stroke();

            // Failed signal indicator (X mark)
            if (signal.failed) {
                ctx.strokeStyle = '#ff0000';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(position.x - 4, position.y - 4);
                ctx.lineTo(position.x + 4, position.y + 4);
                ctx.moveTo(position.x + 4, position.y - 4);
                ctx.lineTo(position.x - 4, position.y + 4);
                ctx.stroke();
            }

            // Hovered / Selected highlight
            if (this.hoveredEntity === signal.id || this.selectedEntity === signal.id) {
                ctx.beginPath();
                ctx.arc(position.x, position.y, radius + 6, 0, Math.PI * 2);
                ctx.strokeStyle = COLORS.selectionGlow;
                ctx.lineWidth = 1.5;
                ctx.globalAlpha = 0.6;
                ctx.stroke();
                ctx.globalAlpha = 1;
            }
        });
    }

    // ──────────────────────────────────────────
    // TRAINS
    // ──────────────────────────────────────────

    private renderTrains(world: GameWorld): void {
        const ctx = this.ctx;

        world.trains.forEach((train) => {
            const { worldPos } = train.position;
            const segment = world.segments.get(train.position.segmentId);
            if (!segment) return;

            const startNode = world.nodes.get(segment.startNodeId);
            const endNode = world.nodes.get(segment.endNodeId);
            if (!startNode || !endNode) return;

            // Calculate train direction
            const dx = endNode.position.x - startNode.position.x;
            const dy = endNode.position.y - startNode.position.y;
            const len = Math.sqrt(dx * dx + dy * dy) || 1;
            const dirX = dx / len;
            const dirY = dy / len;

            // Train dimensions (scaled by actual length, but clamped for visibility)
            const trainVisualLength = Math.min(Math.max(train.length * 0.15, 15), 40);
            const trainWidth = train.type === 'FREIGHT' ? 6 : 5;

            // Train body
            ctx.save();
            ctx.translate(worldPos.x, worldPos.y);
            ctx.rotate(Math.atan2(dirY, dirX));

            // Shadow / glow under train
            ctx.fillStyle = train.color;
            ctx.globalAlpha = 0.1;
            ctx.fillRect(-trainVisualLength / 2 - 2, -trainWidth - 2, trainVisualLength + 4, trainWidth * 2 + 4);
            ctx.globalAlpha = 1;

            // Train body rectangle
            ctx.fillStyle = train.color;
            ctx.fillRect(-trainVisualLength / 2, -trainWidth, trainVisualLength, trainWidth * 2);

            // Train outline
            ctx.strokeStyle = COLORS.trainOutline;
            ctx.lineWidth = 0.5;
            ctx.strokeRect(-trainVisualLength / 2, -trainWidth, trainVisualLength, trainWidth * 2);

            // Front indicator (thin white line at the front)
            ctx.fillStyle = '#ffffff';
            ctx.globalAlpha = 0.6;
            ctx.fillRect(trainVisualLength / 2 - 1.5, -trainWidth + 1, 1.5, trainWidth * 2 - 2);
            ctx.globalAlpha = 1;

            // Stalled indicator (flashing)
            if (train.state === TrainState.STALLED) {
                const flash = Math.sin(Date.now() / 300) > 0;
                if (flash) {
                    ctx.fillStyle = '#ff4444';
                    ctx.globalAlpha = 0.4;
                    ctx.fillRect(-trainVisualLength / 2, -trainWidth, trainVisualLength, trainWidth * 2);
                    ctx.globalAlpha = 1;
                }
            }

            ctx.restore();

            // Headcode label
            const labelY = worldPos.y - trainWidth - 10;
            ctx.font = '9px "JetBrains Mono", "Courier New", monospace';
            ctx.textAlign = 'center';
            ctx.fillStyle = COLORS.headcode;
            ctx.fillText(train.headcode, worldPos.x, labelY);

            // Delay indicator
            if (train.delay > 30) {
                const delayMin = Math.floor(train.delay / 60);
                ctx.font = '8px "JetBrains Mono", "Courier New", monospace';
                ctx.fillStyle = COLORS.delay;
                ctx.fillText(`+${delayMin}m`, worldPos.x, labelY - 10);
            }

            // Hovered / Selected highlight
            if (this.hoveredEntity === train.id || this.selectedEntity === train.id) {
                ctx.beginPath();
                ctx.arc(worldPos.x, worldPos.y, trainVisualLength / 2 + 4, 0, Math.PI * 2);
                ctx.strokeStyle = COLORS.selectionGlow;
                ctx.lineWidth = 1.5;
                ctx.globalAlpha = 0.6;
                ctx.stroke();
                ctx.globalAlpha = 1;
            }
        });
    }

    // ──────────────────────────────────────────
    // POINTS
    // ──────────────────────────────────────────

    private renderPoints(world: GameWorld): void {
        const ctx = this.ctx;

        world.points.forEach((pts) => {
            const node = world.nodes.get(pts.nodeId);
            if (!node) return;

            const pos = node.position;

            // Points indicator — small diamond
            const size = 4;
            ctx.beginPath();
            ctx.moveTo(pos.x, pos.y - size);
            ctx.lineTo(pos.x + size, pos.y);
            ctx.lineTo(pos.x, pos.y + size);
            ctx.lineTo(pos.x - size, pos.y);
            ctx.closePath();

            if (pts.failed) {
                ctx.fillStyle = COLORS.pointsFailed;
            } else if (pts.locked) {
                ctx.fillStyle = COLORS.pointsLocked;
            } else if (pts.position === PointsPosition.REVERSE) {
                ctx.fillStyle = COLORS.pointsReverse;
            } else {
                ctx.fillStyle = COLORS.pointsNormal;
            }

            ctx.fill();
            ctx.strokeStyle = '#000';
            ctx.lineWidth = 0.5;
            ctx.stroke();

            // Points position label
            if (this.camera.zoom > 0.7) {
                ctx.font = '7px "JetBrains Mono", monospace';
                ctx.textAlign = 'center';
                ctx.fillStyle = '#666';
                const label = pts.failed ? 'FAIL' :
                    pts.position === PointsPosition.NORMAL ? 'N' :
                        pts.position === PointsPosition.REVERSE ? 'R' : '?';
                ctx.fillText(label, pos.x, pos.y + size + 10);

                if (pts.locked) {
                    ctx.fillStyle = '#4a4a8a';
                    ctx.fillText('🔒', pos.x - 3, pos.y - size - 4);
                }
            }
        });
    }

    // ──────────────────────────────────────────
    // STATIONS
    // ──────────────────────────────────────────

    private renderStations(world: GameWorld): void {
        const ctx = this.ctx;

        world.stations.forEach((station) => {
            const pos = station.position;

            // Station name label
            ctx.font = `${11 / Math.max(this.camera.zoom, 0.5)}px "Inter", "Segoe UI", sans-serif`;
            ctx.textAlign = 'center';
            ctx.fillStyle = COLORS.stationLabel;
            ctx.fillText(station.name, pos.x, pos.y - 35);

            // Platform count
            ctx.font = `${8 / Math.max(this.camera.zoom, 0.5)}px "JetBrains Mono", monospace`;
            ctx.fillStyle = COLORS.stationPlatform;
            ctx.fillText(`${station.platformCount} platform${station.platformCount > 1 ? 's' : ''}`, pos.x, pos.y - 22);

            // Platform number labels
            station.platformSegmentIds.forEach((segId, i) => {
                const seg = world.segments.get(segId);
                if (!seg) return;

                const startNode = world.nodes.get(seg.startNodeId);
                const endNode = world.nodes.get(seg.endNodeId);
                if (!startNode || !endNode) return;

                const midX = (startNode.position.x + endNode.position.x) / 2;
                const midY = (startNode.position.y + endNode.position.y) / 2;

                ctx.font = '8px "JetBrains Mono", monospace';
                ctx.fillStyle = '#404040';
                ctx.fillText(`P${i + 1}`, midX, midY + 18);
            });
        });
    }

    // ──────────────────────────────────────────
    // ROUTE INDICATORS
    // ──────────────────────────────────────────

    private renderRouteIndicators(world: GameWorld): void {
        const ctx = this.ctx;

        world.routes.forEach((route) => {
            if (route.state === RouteState.UNSET) return;

            const color = route.state === RouteState.SET ? COLORS.routeSet :
                route.state === RouteState.SETTING ? COLORS.routeRequested : COLORS.routeSet;

            ctx.globalAlpha = 0.15;

            route.blockIds.forEach(blockId => {
                const block = world.blocks.get(blockId);
                if (!block) return;

                const segment = world.segments.get(block.segmentId);
                if (!segment) return;

                const startNode = world.nodes.get(segment.startNodeId);
                const endNode = world.nodes.get(segment.endNodeId);
                if (!startNode || !endNode) return;

                const startPos = this.lerpPos(startNode.position, endNode.position, block.startT);
                const endPos = this.lerpPos(startNode.position, endNode.position, block.endT);

                ctx.strokeStyle = color;
                ctx.lineWidth = 8;
                ctx.beginPath();
                ctx.moveTo(startPos.x, startPos.y);
                ctx.lineTo(endPos.x, endPos.y);
                ctx.stroke();
            });

            ctx.globalAlpha = 1;
        });
    }

    // ──────────────────────────────────────────
    // SCREEN-SPACE INFO
    // ──────────────────────────────────────────

    private renderScreenSpaceInfo(world: GameWorld, width: number, height: number): void {
        const ctx = this.ctx;

        // Bottom-left: simulation time
        const hours = Math.floor(world.time / 3600) % 24;
        const minutes = Math.floor((world.time % 3600) / 60);
        const seconds = Math.floor(world.time % 60);
        const timeStr = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;

        ctx.font = '14px "JetBrains Mono", "Courier New", monospace';
        ctx.fillStyle = '#555555';
        ctx.textAlign = 'left';
        ctx.fillText(timeStr, 16, height - 16);

        // Time scale indicator
        if (world.timeScale !== 1) {
            ctx.fillStyle = '#666';
            ctx.fillText(`×${world.timeScale}`, 100, height - 16);
        }

        // Bottom-right: OpenGen version
        ctx.font = '9px "JetBrains Mono", "Courier New", monospace';
        ctx.fillStyle = '#333';
        ctx.textAlign = 'right';
        ctx.fillText(`OpenGen ${world.opengenVersion}`, width - 16, height - 16);
        ctx.fillText(`Seed: ${world.seed}`, width - 16, height - 30);

        // Active failures count
        const activeFailures = Array.from(world.failures.values()).filter(f => !f.resolved);
        if (activeFailures.length > 0) {
            ctx.font = '11px "JetBrains Mono", monospace';
            ctx.fillStyle = '#e53935';
            ctx.textAlign = 'right';
            ctx.fillText(`⚠ ${activeFailures.length} active failure${activeFailures.length > 1 ? 's' : ''}`, width - 16, 30);
        }
    }

    // ──────────────────────────────────────────
    // HELPERS
    // ──────────────────────────────────────────

    private lerpPos(a: Vec2, b: Vec2, t: number): Vec2 {
        return {
            x: a.x + (b.x - a.x) * t,
            y: a.y + (b.y - a.y) * t,
        };
    }

    /**
     * Hit-test: find entity at a screen position.
     */
    hitTest(world: GameWorld, screenPos: Vec2): { type: string; id: EntityId } | null {
        const worldPos = this.screenToWorld(screenPos);

        // Check trains first (most likely target)
        for (const [id, train] of world.trains) {
            const dist = Math.sqrt(
                (train.position.worldPos.x - worldPos.x) ** 2 +
                (train.position.worldPos.y - worldPos.y) ** 2
            );
            if (dist < 25 / this.camera.zoom) {
                return { type: 'train', id };
            }
        }

        // Check signals
        for (const [id, signal] of world.signals) {
            const dist = Math.sqrt(
                (signal.position.x - worldPos.x) ** 2 +
                (signal.position.y - worldPos.y) ** 2
            );
            if (dist < 15 / this.camera.zoom) {
                return { type: 'signal', id };
            }
        }

        // Check points
        for (const [id, pts] of world.points) {
            const node = world.nodes.get(pts.nodeId);
            if (!node) continue;
            const dist = Math.sqrt(
                (node.position.x - worldPos.x) ** 2 +
                (node.position.y - worldPos.y) ** 2
            );
            if (dist < 15 / this.camera.zoom) {
                return { type: 'points', id };
            }
        }

        // Check stations
        for (const [id, station] of world.stations) {
            const dist = Math.sqrt(
                (station.position.x - worldPos.x) ** 2 +
                (station.position.y - worldPos.y) ** 2
            );
            if (dist < 40 / this.camera.zoom) {
                return { type: 'station', id };
            }
        }

        return null;
    }
}
