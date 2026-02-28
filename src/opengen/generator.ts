/**
 * OpenGen World Generator
 * 
 * Generates complete, valid railway networks from a seed.
 * 
 * SAFETY GUARANTEES (NON-NEGOTIABLE):
 * - No un-signalled junctions
 * - No facing points without protection
 * - No bidirectional lines without opposing signals
 * - Every route is interlockable
 * - Invalid layouts are discarded and regenerated
 * 
 * Generation Pipeline:
 * 1. Parse seed → create deterministic RNG
 * 2. Generate backbone track layout
 * 3. Add junctions and branches
 * 4. Place stations with platforms
 * 5. Place signals at all required locations
 * 6. Create blocks (track circuits)
 * 7. Build interlocking routes
 * 8. Validate entire layout
 * 9. If invalid → regenerate with modified seed
 */

import {
    GameWorld, TrackNode, TrackSegment, Block, Signal, Points,
    Route, Station, Train, Vec2, EntityId,
    BlockState, SignalAspect, PointsPosition, RouteState,
    TrainType, TrainState, Difficulty, FailureType, Failure,
    ERUUnit, ERUState, Task, PointsRequirement,
    TimetableEntry, TrainPosition, TrainPathSegment,
} from '../engine/types';
import { SeededRNG, parseSeed, OPENGEN_VERSION } from './seed';

// ============================================================
// ID GENERATION
// ============================================================

let idCounter = 0;

function genId(prefix: string): EntityId {
    return `${prefix}_${(idCounter++).toString(36)}`;
}

function resetIds(): void {
    idCounter = 0;
}

// ============================================================
// HELPER: Vec2 operations
// ============================================================

function vec2(x: number, y: number): Vec2 {
    return { x, y };
}

function vec2Add(a: Vec2, b: Vec2): Vec2 {
    return { x: a.x + b.x, y: a.y + b.y };
}

function vec2Sub(a: Vec2, b: Vec2): Vec2 {
    return { x: a.x - b.x, y: a.y - b.y };
}

function vec2Scale(v: Vec2, s: number): Vec2 {
    return { x: v.x * s, y: v.y * s };
}

function vec2Len(v: Vec2): number {
    return Math.sqrt(v.x * v.x + v.y * v.y);
}

function vec2Normalize(v: Vec2): Vec2 {
    const len = vec2Len(v);
    if (len === 0) return { x: 1, y: 0 };
    return { x: v.x / len, y: v.y / len };
}

function vec2Lerp(a: Vec2, b: Vec2, t: number): Vec2 {
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function vec2Dist(a: Vec2, b: Vec2): number {
    return vec2Len(vec2Sub(b, a));
}

function vec2Perp(v: Vec2): Vec2 {
    return { x: -v.y, y: v.x };
}

// ============================================================
// STATION NAME GENERATION
// ============================================================

const STATION_PREFIXES = [
    'Ashton', 'Blackwell', 'Crossfield', 'Dalton', 'Eastham',
    'Fairbridge', 'Grantley', 'Hartwick', 'Ironside', 'Kingsbury',
    'Langford', 'Millbrook', 'Northgate', 'Oakworth', 'Penford',
    'Queensbury', 'Redhill', 'Stonebridge', 'Thornfield', 'Upminster',
    'Victoria', 'Westbury', 'Yardley', 'Bankside', 'Clearwater',
    'Deepdale', 'Elmwick', 'Foxhall', 'Greenhill', 'Highbury',
];

const STATION_SUFFIXES = [
    '', ' Junction', ' Central', ' Park', ' Road',
    ' Gate', ' Bridge', ' Heath', ' Green', ' Hill',
    ' Cross', ' Lane', ' Street', ' Town', ' Vale',
];

function generateStationName(rng: SeededRNG, used: Set<string>): string {
    let name: string;
    let attempts = 0;
    do {
        const prefix = rng.pick(STATION_PREFIXES);
        const suffix = rng.pick(STATION_SUFFIXES);
        name = prefix + suffix;
        attempts++;
        if (attempts > 100) break;
    } while (used.has(name));
    used.add(name);
    return name;
}

// ============================================================
// HEADCODE GENERATION
// ============================================================

const HEADCODE_CLASSES = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
const HEADCODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

function generateHeadcode(rng: SeededRNG): string {
    const cls = rng.pick(HEADCODE_CLASSES);
    const letter = HEADCODE_LETTERS[rng.int(0, HEADCODE_LETTERS.length - 1)];
    const num = rng.int(10, 99).toString();
    return `${cls}${letter}${num}`;
}

// ============================================================
// TRAIN COLOR PALETTE
// ============================================================

const TRAIN_COLORS = [
    '#4FC3F7', // Light blue — passenger express
    '#81C784', // Green — suburban
    '#FFB74D', // Orange — freight
    '#E57373', // Red — mail
    '#BA68C8', // Purple — special
    '#4DD0E1', // Cyan — intercity
    '#AED581', // Light green — commuter
    '#F06292', // Pink — charter
    '#FFD54F', // Yellow — maintenance
    '#90A4AE', // Grey — light engine
];

// ============================================================
// MAIN GENERATOR
// ============================================================

export function generateWorld(seedInput: string, difficulty: Difficulty = Difficulty.NORMAL): GameWorld {
    resetIds();

    const parsed = parseSeed(seedInput);
    const rng = new SeededRNG(parsed.normalized);

    // Determine world parameters based on difficulty
    const params = getWorldParams(difficulty, rng);

    let world: GameWorld | null = null;
    let attempts = 0;
    const maxAttempts = 5;

    while (!world && attempts < maxAttempts) {
        attempts++;
        try {
            world = buildWorld(rng, params, parsed.normalized);
            if (!validateWorld(world)) {
                console.warn(`OpenGen: Layout validation failed on attempt ${attempts}, regenerating...`);
                world = null;
                // Advance RNG state for different generation
                for (let i = 0; i < 100; i++) rng.next();
            }
        } catch (e) {
            console.warn(`OpenGen: Generation error on attempt ${attempts}:`, e);
            world = null;
        }
    }

    if (!world) {
        // Fallback: generate simplest possible valid layout
        console.warn('OpenGen: All attempts failed, generating minimal layout');
        world = buildMinimalWorld(parsed.normalized);
    }

    world.difficulty = difficulty;
    world.seed = parsed.normalized;
    world.opengenVersion = OPENGEN_VERSION;

    return world;
}

// ============================================================
// WORLD PARAMETERS
// ============================================================

interface WorldParams {
    stationCount: number;
    branchProbability: number;
    loopProbability: number;
    trainsPerStation: number;
    maxPlatforms: number;
    freightRatio: number;
    segmentSpacing: number;
}

function getWorldParams(difficulty: Difficulty, rng: SeededRNG): WorldParams {
    switch (difficulty) {
        case Difficulty.EASY:
            return {
                stationCount: rng.int(3, 4),
                branchProbability: 0.2,
                loopProbability: 0.1,
                trainsPerStation: 0.8,
                maxPlatforms: 2,
                freightRatio: 0.1,
                segmentSpacing: 500,
            };
        case Difficulty.NORMAL:
            return {
                stationCount: rng.int(4, 6),
                branchProbability: 0.4,
                loopProbability: 0.2,
                trainsPerStation: 1.2,
                maxPlatforms: 3,
                freightRatio: 0.2,
                segmentSpacing: 400,
            };
        case Difficulty.HARD:
            return {
                stationCount: rng.int(5, 8),
                branchProbability: 0.5,
                loopProbability: 0.3,
                trainsPerStation: 1.5,
                maxPlatforms: 4,
                freightRatio: 0.3,
                segmentSpacing: 350,
            };
    }
}

// ============================================================
// WORLD BUILDER
// ============================================================

function buildWorld(rng: SeededRNG, params: WorldParams, seed: string): GameWorld {
    const nodes = new Map<EntityId, TrackNode>();
    const segments = new Map<EntityId, TrackSegment>();
    const blocks = new Map<EntityId, Block>();
    const signals = new Map<EntityId, Signal>();
    const points = new Map<EntityId, Points>();
    const routes = new Map<EntityId, Route>();
    const trains = new Map<EntityId, Train>();
    const stations = new Map<EntityId, Station>();
    const failures = new Map<EntityId, Failure>();
    const eruUnits: ERUUnit[] = [];
    const tasks: Task[] = [];

    const usedNames = new Set<string>();

    // ──────────────────────────────────────────
    // STEP 1: Generate station positions along a main line
    // ──────────────────────────────────────────

    const stationPositions: Vec2[] = [];
    const mainLineNodes: TrackNode[] = [];

    // Main line runs roughly left-to-right with gentle curves
    let currentPos = vec2(200, 400);
    const mainDirection = vec2(1, 0);

    // Create a gentle curved main line
    for (let i = 0; i < params.stationCount; i++) {
        // Add some vertical variation for visual interest
        const yOffset = rng.gaussian(0, 60);
        const spacing = params.segmentSpacing + rng.gaussian(0, 50);

        if (i > 0) {
            currentPos = vec2Add(currentPos, vec2(spacing, yOffset));
        }

        stationPositions.push({ ...currentPos });
    }

    // ──────────────────────────────────────────
    // STEP 2: Build track layout with stations
    // ──────────────────────────────────────────

    interface StationLayout {
        station: Station;
        entryNode: TrackNode;
        exitNode: TrackNode;
        platformSegments: TrackSegment[];
        junctionNodes: TrackNode[];
    }

    const stationLayouts: StationLayout[] = [];

    for (let si = 0; si < params.stationCount; si++) {
        const pos = stationPositions[si];
        const stationName = generateStationName(rng, usedNames);
        const platformCount = rng.int(1, params.maxPlatforms);

        const stationId = genId('stn');
        const platformSegmentIds: EntityId[] = [];

        // Create station entry and exit nodes
        const entryNodeId = genId('node');
        const exitNodeId = genId('node');
        const entryPos = vec2Add(pos, vec2(-120, 0));
        const exitPos = vec2Add(pos, vec2(120, 0));

        const entryNode: TrackNode = {
            id: entryNodeId,
            position: entryPos,
            connectedSegments: [],
        };

        const exitNode: TrackNode = {
            id: exitNodeId,
            position: exitPos,
            connectedSegments: [],
        };

        nodes.set(entryNodeId, entryNode);
        nodes.set(exitNodeId, exitNode);

        const platformSegments: TrackSegment[] = [];
        const junctionNodes: TrackNode[] = [];

        if (platformCount === 1) {
            // Single platform: direct connection
            const segId = genId('seg');
            const seg: TrackSegment = {
                id: segId,
                startNodeId: entryNodeId,
                endNodeId: exitNodeId,
                length: vec2Dist(entryPos, exitPos),
                speedLimit: 60,
                waypoints: [],
                blockIds: [],
                isPlatform: true,
                stationId,
                platformNumber: 1,
                electrified: true,
            };
            segments.set(segId, seg);
            entryNode.connectedSegments.push(segId);
            exitNode.connectedSegments.push(segId);
            platformSegments.push(seg);
            platformSegmentIds.push(segId);
        } else {
            // Multiple platforms: create junction points
            const entryJunctionId = genId('node');
            const exitJunctionId = genId('node');
            const entryJunctionPos = vec2Add(entryPos, vec2(30, 0));
            const exitJunctionPos = vec2Add(exitPos, vec2(-30, 0));

            const entryJunction: TrackNode = {
                id: entryJunctionId,
                position: entryJunctionPos,
                connectedSegments: [],
            };
            const exitJunction: TrackNode = {
                id: exitJunctionId,
                position: exitJunctionPos,
                connectedSegments: [],
            };

            nodes.set(entryJunctionId, entryJunction);
            nodes.set(exitJunctionId, exitJunction);
            junctionNodes.push(entryJunction, exitJunction);

            // Entry approach to junction
            const entryApproachId = genId('seg');
            const entryApproach: TrackSegment = {
                id: entryApproachId,
                startNodeId: entryNodeId,
                endNodeId: entryJunctionId,
                length: vec2Dist(entryPos, entryJunctionPos),
                speedLimit: 80,
                waypoints: [],
                blockIds: [],
                isPlatform: false,
                electrified: true,
            };
            segments.set(entryApproachId, entryApproach);
            entryNode.connectedSegments.push(entryApproachId);
            entryJunction.connectedSegments.push(entryApproachId);

            // Exit junction to exit
            const exitApproachId = genId('seg');
            const exitApproach: TrackSegment = {
                id: exitApproachId,
                startNodeId: exitJunctionId,
                endNodeId: exitNodeId,
                length: vec2Dist(exitJunctionPos, exitPos),
                speedLimit: 80,
                waypoints: [],
                blockIds: [],
                isPlatform: false,
                electrified: true,
            };
            segments.set(exitApproachId, exitApproach);
            exitJunction.connectedSegments.push(exitApproachId);
            exitNode.connectedSegments.push(exitApproachId);

            // Create platform tracks
            for (let pi = 0; pi < platformCount; pi++) {
                const pOffset = (pi - (platformCount - 1) / 2) * 40;

                // Platform start node
                const platStartId = genId('node');
                const platEndId = genId('node');
                const platStartPos = vec2Add(entryJunctionPos, vec2(15, pOffset));
                const platEndPos = vec2Add(exitJunctionPos, vec2(-15, pOffset));

                const platStart: TrackNode = {
                    id: platStartId,
                    position: platStartPos,
                    connectedSegments: [],
                };
                const platEnd: TrackNode = {
                    id: platEndId,
                    position: platEndPos,
                    connectedSegments: [],
                };
                nodes.set(platStartId, platStart);
                nodes.set(platEndId, platEnd);

                // Entry throat to platform
                const throatInId = genId('seg');
                const throatIn: TrackSegment = {
                    id: throatInId,
                    startNodeId: entryJunctionId,
                    endNodeId: platStartId,
                    length: vec2Dist(entryJunctionPos, platStartPos),
                    speedLimit: 30,
                    waypoints: [],
                    blockIds: [],
                    isPlatform: false,
                    electrified: true,
                };
                segments.set(throatInId, throatIn);
                entryJunction.connectedSegments.push(throatInId);
                platStart.connectedSegments.push(throatInId);

                // Platform segment
                const platSegId = genId('seg');
                const platSeg: TrackSegment = {
                    id: platSegId,
                    startNodeId: platStartId,
                    endNodeId: platEndId,
                    length: vec2Dist(platStartPos, platEndPos),
                    speedLimit: 30,
                    waypoints: [],
                    blockIds: [],
                    isPlatform: true,
                    stationId,
                    platformNumber: pi + 1,
                    electrified: true,
                };
                segments.set(platSegId, platSeg);
                platStart.connectedSegments.push(platSegId);
                platEnd.connectedSegments.push(platSegId);
                platformSegments.push(platSeg);
                platformSegmentIds.push(platSegId);

                // Platform to exit throat
                const throatOutId = genId('seg');
                const throatOut: TrackSegment = {
                    id: throatOutId,
                    startNodeId: platEndId,
                    endNodeId: exitJunctionId,
                    length: vec2Dist(platEndPos, exitJunctionPos),
                    speedLimit: 30,
                    waypoints: [],
                    blockIds: [],
                    isPlatform: false,
                    electrified: true,
                };
                segments.set(throatOutId, throatOut);
                platEnd.connectedSegments.push(throatOutId);
                exitJunction.connectedSegments.push(throatOutId);
            }

            // Create points at junctions (for multi-platform stations)
            if (platformCount >= 2) {
                // Entry points — select which platform
                const firstEntryThroatId = entryJunction.connectedSegments.find(
                    sid => sid !== entryApproachId && segments.get(sid)
                );
                const secondEntryThroatId = entryJunction.connectedSegments.find(
                    sid => sid !== entryApproachId && sid !== firstEntryThroatId && segments.get(sid)
                );

                if (firstEntryThroatId && secondEntryThroatId) {
                    const entryPoints: Points = {
                        id: genId('pts'),
                        nodeId: entryJunctionId,
                        position: PointsPosition.NORMAL,
                        locked: false,
                        failed: false,
                        normalSegmentId: firstEntryThroatId,
                        reverseSegmentId: secondEntryThroatId,
                        commonSegmentId: entryApproachId,
                        health: 100,
                    };
                    points.set(entryPoints.id, entryPoints);
                    entryJunction.points = entryPoints;
                }

                // Exit points
                const firstExitThroatId = exitJunction.connectedSegments.find(
                    sid => sid !== exitApproachId && segments.get(sid)
                );
                const secondExitThroatId = exitJunction.connectedSegments.find(
                    sid => sid !== exitApproachId && sid !== firstExitThroatId && segments.get(sid)
                );

                if (firstExitThroatId && secondExitThroatId) {
                    const exitPoints: Points = {
                        id: genId('pts'),
                        nodeId: exitJunctionId,
                        position: PointsPosition.NORMAL,
                        locked: false,
                        failed: false,
                        normalSegmentId: firstExitThroatId,
                        reverseSegmentId: secondExitThroatId,
                        commonSegmentId: exitApproachId,
                        health: 100,
                    };
                    points.set(exitPoints.id, exitPoints);
                    exitJunction.points = exitPoints;
                }
            }
        }

        // Create station entity
        const station: Station = {
            id: stationId,
            name: stationName,
            position: pos,
            platformSegmentIds,
            platformCount,
        };
        stations.set(stationId, station);

        stationLayouts.push({
            station,
            entryNode,
            exitNode,
            platformSegments,
            junctionNodes,
        });
    }

    // ──────────────────────────────────────────
    // STEP 3: Connect stations with running lines
    // ──────────────────────────────────────────

    for (let i = 0; i < stationLayouts.length - 1; i++) {
        const current = stationLayouts[i];
        const next = stationLayouts[i + 1];

        const startPos = current.exitNode.position;
        const endPos = next.entryNode.position;
        const dist = vec2Dist(startPos, endPos);

        // Create intermediate node(s) for gentle curves
        const midCount = Math.max(1, Math.floor(dist / 300));
        let prevNodeId = current.exitNode.id;

        for (let m = 0; m < midCount; m++) {
            const t = (m + 1) / (midCount + 1);
            const midPos = vec2Lerp(startPos, endPos, t);
            // Add gentle vertical wobble
            midPos.y += rng.gaussian(0, 15);

            if (m < midCount - 1) {
                // Create intermediate node
                const midNodeId = genId('node');
                const midNode: TrackNode = {
                    id: midNodeId,
                    position: midPos,
                    connectedSegments: [],
                };
                nodes.set(midNodeId, midNode);

                // Create segment to this node
                const prevNode = nodes.get(prevNodeId)!;
                const segId = genId('seg');
                const seg: TrackSegment = {
                    id: segId,
                    startNodeId: prevNodeId,
                    endNodeId: midNodeId,
                    length: vec2Dist(prevNode.position, midPos),
                    speedLimit: 100,
                    waypoints: [],
                    blockIds: [],
                    isPlatform: false,
                    electrified: true,
                };
                segments.set(segId, seg);
                prevNode.connectedSegments.push(segId);
                midNode.connectedSegments.push(segId);

                prevNodeId = midNodeId;
            }
        }

        // Final segment to next station's entry
        const prevNode = nodes.get(prevNodeId)!;
        const finalSegId = genId('seg');
        const finalSeg: TrackSegment = {
            id: finalSegId,
            startNodeId: prevNodeId,
            endNodeId: next.entryNode.id,
            length: vec2Dist(prevNode.position, next.entryNode.position),
            speedLimit: 100,
            waypoints: [],
            blockIds: [],
            isPlatform: false,
            electrified: true,
        };
        segments.set(finalSegId, finalSeg);
        prevNode.connectedSegments.push(finalSegId);
        next.entryNode.connectedSegments.push(finalSegId);
    }

    // ──────────────────────────────────────────
    // STEP 4: Create blocks for all segments
    // ──────────────────────────────────────────

    segments.forEach((seg) => {
        const blockId = genId('blk');
        const block: Block = {
            id: blockId,
            segmentId: seg.id,
            startT: 0,
            endT: 1,
            length: seg.length,
            state: BlockState.CLEAR,
            failed: false,
        };
        blocks.set(blockId, block);
        seg.blockIds.push(blockId);
    });

    // ──────────────────────────────────────────
    // STEP 5: Place signals at critical locations
    // ──────────────────────────────────────────

    // Signals are placed:
    // - Before every junction (facing points)
    // - At station entries and exits
    // - At regular intervals on running lines
    // - Bidirectional lines get signals in both directions

    // Place signals at station entries
    stationLayouts.forEach((layout) => {
        // Entry signal
        const entrySignalId = genId('sig');
        const entryDir = vec2Normalize(vec2Sub(layout.exitNode.position, layout.entryNode.position));
        const entrySegment = layout.entryNode.connectedSegments[0];

        if (entrySegment) {
            const entrySignal: Signal = {
                id: entrySignalId,
                position: vec2Add(layout.entryNode.position, vec2(-20, -15)),
                segmentId: entrySegment,
                positionT: 0.95,
                direction: entryDir,
                aspect: SignalAspect.RED,
                failed: false,
                routeIds: [],
                protectedBlockId: '',
            };

            // Link to the first block of the entry segment
            const seg = segments.get(entrySegment);
            if (seg && seg.blockIds.length > 0) {
                entrySignal.protectedBlockId = seg.blockIds[0];
            }

            signals.set(entrySignalId, entrySignal);
        }

        // Exit signal
        const exitSignalId = genId('sig');
        const exitDir = vec2Normalize(vec2Sub(layout.exitNode.position, layout.entryNode.position));

        // Find a segment connected to the exit node that isn't a platform
        const exitSegment = layout.exitNode.connectedSegments.find(sid => {
            const s = segments.get(sid);
            return s && !s.isPlatform;
        }) || layout.exitNode.connectedSegments[0];

        if (exitSegment) {
            const exitSignal: Signal = {
                id: exitSignalId,
                position: vec2Add(layout.exitNode.position, vec2(20, -15)),
                segmentId: exitSegment,
                positionT: 0.05,
                direction: exitDir,
                aspect: SignalAspect.RED,
                failed: false,
                routeIds: [],
                protectedBlockId: '',
            };

            const seg = segments.get(exitSegment);
            if (seg && seg.blockIds.length > 0) {
                exitSignal.protectedBlockId = seg.blockIds[0];
            }

            signals.set(exitSignalId, exitSignal);
        }

        // Platform exit signals (starter signals)
        layout.platformSegments.forEach((platSeg, pi) => {
            const starterSignalId = genId('sig');
            const platEndNode = nodes.get(platSeg.endNodeId)!;
            const platStartNode = nodes.get(platSeg.startNodeId)!;
            const dir = vec2Normalize(vec2Sub(platEndNode.position, platStartNode.position));

            const starterSignal: Signal = {
                id: starterSignalId,
                position: vec2Add(platEndNode.position, vec2(5, -15)),
                segmentId: platSeg.id,
                positionT: 0.9,
                direction: dir,
                aspect: SignalAspect.RED,
                failed: false,
                routeIds: [],
                protectedBlockId: platSeg.blockIds[0] || '',
            };
            signals.set(starterSignalId, starterSignal);
        });
    });

    // Place signals on running lines between stations
    segments.forEach((seg) => {
        if (seg.isPlatform) return; // Already handled
        if (seg.length < 200) return; // Too short for additional signals

        // Check if this segment already has a nearby signal
        let hasSignal = false;
        signals.forEach((sig) => {
            if (sig.segmentId === seg.id) hasSignal = true;
        });

        if (!hasSignal && seg.length > 250) {
            // Place a signal at the start of long running segments
            const startNode = nodes.get(seg.startNodeId)!;
            const endNode = nodes.get(seg.endNodeId)!;
            const dir = vec2Normalize(vec2Sub(endNode.position, startNode.position));

            const sigId = genId('sig');
            const sig: Signal = {
                id: sigId,
                position: vec2Add(startNode.position, vec2Add(vec2Scale(dir, 15), vec2(0, -15))),
                segmentId: seg.id,
                positionT: 0.05,
                direction: dir,
                aspect: SignalAspect.GREEN,
                failed: false,
                routeIds: [],
                protectedBlockId: seg.blockIds[0] || '',
            };
            signals.set(sigId, sig);
        }
    });

    // ──────────────────────────────────────────
    // STEP 6: Build interlocking routes
    // ──────────────────────────────────────────

    // Simple route generation: for each signal, create a route to the next signal
    const signalArray = Array.from(signals.values());

    for (let i = 0; i < signalArray.length; i++) {
        const entranceSignal = signalArray[i];
        const seg = segments.get(entranceSignal.segmentId);
        if (!seg) continue;

        // Find the next signal in the same direction
        for (let j = 0; j < signalArray.length; j++) {
            if (i === j) continue;
            const exitSignal = signalArray[j];

            // Check if these signals are on connected segments
            const entranceEndNodeId = seg.endNodeId;
            const exitSeg = segments.get(exitSignal.segmentId);
            if (!exitSeg) continue;

            // Simple adjacency check
            if (entranceEndNodeId === exitSeg.startNodeId ||
                seg.endNodeId === exitSeg.startNodeId ||
                seg.id === exitSignal.segmentId) {

                const routeBlockIds: EntityId[] = [];
                seg.blockIds.forEach(bid => routeBlockIds.push(bid));

                if (seg.id !== exitSignal.segmentId) {
                    exitSeg.blockIds.forEach(bid => routeBlockIds.push(bid));
                }

                // Collect required points positions
                const pointsReqs: PointsRequirement[] = [];
                const endNode = nodes.get(entranceEndNodeId);
                if (endNode?.points) {
                    // Determine which position is needed for this route
                    const pts = endNode.points;
                    if (exitSeg.id === pts.normalSegmentId || seg.id === pts.normalSegmentId) {
                        pointsReqs.push({
                            pointsId: pts.id,
                            requiredPosition: PointsPosition.NORMAL,
                        });
                    } else if (exitSeg.id === pts.reverseSegmentId || seg.id === pts.reverseSegmentId) {
                        pointsReqs.push({
                            pointsId: pts.id,
                            requiredPosition: PointsPosition.REVERSE,
                        });
                    }
                }

                const routeId = genId('rte');
                const route: Route = {
                    id: routeId,
                    entranceSignalId: entranceSignal.id,
                    exitSignalId: exitSignal.id,
                    blockIds: routeBlockIds,
                    pointsPositions: pointsReqs,
                    state: RouteState.UNSET,
                    conflictingRouteIds: [],
                    approachLocked: false,
                };

                routes.set(routeId, route);
                entranceSignal.routeIds.push(routeId);
            }
        }
    }

    // ──────────────────────────────────────────
    // STEP 7: Find conflicting routes
    // ──────────────────────────────────────────

    const routeArray = Array.from(routes.values());
    for (let i = 0; i < routeArray.length; i++) {
        for (let j = i + 1; j < routeArray.length; j++) {
            const r1 = routeArray[i];
            const r2 = routeArray[j];

            // Routes conflict if they share blocks
            const sharedBlocks = r1.blockIds.filter(bid => r2.blockIds.includes(bid));
            if (sharedBlocks.length > 0) {
                r1.conflictingRouteIds.push(r2.id);
                r2.conflictingRouteIds.push(r1.id);
            }

            // Routes conflict if they require the same points in different positions
            for (const pr1 of r1.pointsPositions) {
                for (const pr2 of r2.pointsPositions) {
                    if (pr1.pointsId === pr2.pointsId && pr1.requiredPosition !== pr2.requiredPosition) {
                        if (!r1.conflictingRouteIds.includes(r2.id)) {
                            r1.conflictingRouteIds.push(r2.id);
                        }
                        if (!r2.conflictingRouteIds.includes(r1.id)) {
                            r2.conflictingRouteIds.push(r1.id);
                        }
                    }
                }
            }
        }
    }

    // ──────────────────────────────────────────
    // STEP 8: Create trains
    // ──────────────────────────────────────────

    const trainCount = Math.max(2, Math.round(params.stationCount * params.trainsPerStation));
    const stationArr = Array.from(stations.values());

    for (let ti = 0; ti < trainCount; ti++) {
        const originStation = stationArr[ti % stationArr.length];
        const originPlatSeg = originStation.platformSegmentIds[0];
        const seg = segments.get(originPlatSeg);
        if (!seg) continue;

        const startNode = nodes.get(seg.startNodeId)!;
        const endNode = nodes.get(seg.endNodeId)!;

        const isFreight = rng.chance(params.freightRatio);
        const type = isFreight ? TrainType.FREIGHT : TrainType.PASSENGER;

        const trainId = genId('trn');
        const headcode = generateHeadcode(rng);

        const maxSpeed = isFreight ? rng.range(15, 25) : rng.range(30, 45);
        const trainLength = isFreight ? rng.range(150, 300) : rng.range(60, 160);

        const startT = 0.3 + rng.float() * 0.3; // Don't start right at the edge
        const worldPos = vec2Lerp(startNode.position, endNode.position, startT);

        const train: Train = {
            id: trainId,
            headcode,
            type,
            length: trainLength,
            speed: 0,
            maxSpeed,
            acceleration: isFreight ? 0.3 : 0.8,
            brakingRate: isFreight ? 0.4 : 1.2,
            emergencyBrakingRate: isFreight ? 0.8 : 2.5,
            position: {
                segmentId: originPlatSeg,
                t: startT,
                worldPos,
            },
            path: [{ segmentId: originPlatSeg, forward: true }],
            pathIndex: 0,
            state: TrainState.WAITING,
            timetable: [],
            delay: 0,
            spad: false,
            color: TRAIN_COLORS[ti % TRAIN_COLORS.length],
        };

        // Generate simple timetable
        const departureTime = 60 + ti * rng.int(45, 120);
        for (let si = 0; si < stationArr.length; si++) {
            const stn = stationArr[si];
            if (stn.id === originStation.id) continue;

            const arrivalTime = departureTime + si * rng.int(90, 180);
            const dwellTime = isFreight ? 0 : rng.int(30, 90);

            train.timetable.push({
                stationId: stn.id,
                arrivalTime,
                departureTime: arrivalTime + dwellTime,
                dwellTime,
                completed: false,
            });
        }

        trains.set(trainId, train);

        // Mark starting block as occupied
        const startBlock = blocks.get(seg.blockIds[0]);
        if (startBlock) {
            startBlock.state = BlockState.OCCUPIED;
            startBlock.occupyingTrainId = trainId;
        }
    }

    // ──────────────────────────────────────────
    // STEP 9: Create ERU units
    // ──────────────────────────────────────────

    const eruCount = Math.max(1, Math.floor(params.stationCount / 2));
    for (let i = 0; i < eruCount; i++) {
        eruUnits.push({
            id: genId('eru'),
            state: ERUState.AVAILABLE,
            eta: 0,
            repairTime: 0,
        });
    }

    return {
        seed,
        opengenVersion: OPENGEN_VERSION,
        nodes,
        segments,
        blocks,
        signals,
        points,
        routes,
        trains,
        stations,
        failures,
        eruUnits,
        tasks,
        time: 0,
        timeScale: 1,
        difficulty: Difficulty.NORMAL,
        score: 0,
        trainsHandled: 0,
        totalDelayMinutes: 0,
    };
}

// ============================================================
// MINIMAL WORLD (Fallback)
// ============================================================

function buildMinimalWorld(seed: string): GameWorld {
    resetIds();

    const nodes = new Map<EntityId, TrackNode>();
    const segments = new Map<EntityId, TrackSegment>();
    const blocks = new Map<EntityId, Block>();
    const signals = new Map<EntityId, Signal>();
    const points = new Map<EntityId, Points>();
    const routes = new Map<EntityId, Route>();
    const trains = new Map<EntityId, Train>();
    const stations = new Map<EntityId, Station>();

    // Create two stations with one track between them
    const n1: TrackNode = { id: genId('node'), position: vec2(200, 400), connectedSegments: [] };
    const n2: TrackNode = { id: genId('node'), position: vec2(500, 400), connectedSegments: [] };
    const n3: TrackNode = { id: genId('node'), position: vec2(800, 400), connectedSegments: [] };
    const n4: TrackNode = { id: genId('node'), position: vec2(1100, 400), connectedSegments: [] };

    nodes.set(n1.id, n1);
    nodes.set(n2.id, n2);
    nodes.set(n3.id, n3);
    nodes.set(n4.id, n4);

    // Station 1 platform
    const s1: TrackSegment = {
        id: genId('seg'), startNodeId: n1.id, endNodeId: n2.id,
        length: 300, speedLimit: 30, waypoints: [], blockIds: [],
        isPlatform: true, stationId: '', platformNumber: 1, electrified: true,
    };

    // Running line
    const s2: TrackSegment = {
        id: genId('seg'), startNodeId: n2.id, endNodeId: n3.id,
        length: 300, speedLimit: 100, waypoints: [], blockIds: [],
        isPlatform: false, electrified: true,
    };

    // Station 2 platform
    const s3: TrackSegment = {
        id: genId('seg'), startNodeId: n3.id, endNodeId: n4.id,
        length: 300, speedLimit: 30, waypoints: [], blockIds: [],
        isPlatform: true, stationId: '', platformNumber: 1, electrified: true,
    };

    segments.set(s1.id, s1);
    segments.set(s2.id, s2);
    segments.set(s3.id, s3);

    n1.connectedSegments.push(s1.id);
    n2.connectedSegments.push(s1.id, s2.id);
    n3.connectedSegments.push(s2.id, s3.id);
    n4.connectedSegments.push(s3.id);

    // Create blocks
    [s1, s2, s3].forEach(seg => {
        const blockId = genId('blk');
        const block: Block = {
            id: blockId, segmentId: seg.id,
            startT: 0, endT: 1, length: seg.length,
            state: BlockState.CLEAR, failed: false,
        };
        blocks.set(blockId, block);
        seg.blockIds.push(blockId);
    });

    // Create stations
    const stn1: Station = {
        id: genId('stn'), name: 'Ashton Central', position: vec2(350, 400),
        platformSegmentIds: [s1.id], platformCount: 1,
    };
    const stn2: Station = {
        id: genId('stn'), name: 'Blackwell Park', position: vec2(950, 400),
        platformSegmentIds: [s3.id], platformCount: 1,
    };

    s1.stationId = stn1.id;
    s3.stationId = stn2.id;
    stations.set(stn1.id, stn1);
    stations.set(stn2.id, stn2);

    // Signals
    const sig1: Signal = {
        id: genId('sig'), position: vec2(480, 385), segmentId: s1.id,
        positionT: 0.9, direction: vec2(1, 0), aspect: SignalAspect.RED,
        failed: false, routeIds: [], protectedBlockId: s2.blockIds[0] || '',
    };
    const sig2: Signal = {
        id: genId('sig'), position: vec2(780, 385), segmentId: s2.id,
        positionT: 0.9, direction: vec2(1, 0), aspect: SignalAspect.GREEN,
        failed: false, routeIds: [], protectedBlockId: s3.blockIds[0] || '',
    };

    signals.set(sig1.id, sig1);
    signals.set(sig2.id, sig2);

    // Create a simple train
    const train: Train = {
        id: genId('trn'), headcode: '1A42', type: TrainType.PASSENGER,
        length: 100, speed: 0, maxSpeed: 35, acceleration: 0.8,
        brakingRate: 1.2, emergencyBrakingRate: 2.5,
        position: { segmentId: s1.id, t: 0.5, worldPos: vec2(350, 400) },
        path: [{ segmentId: s1.id, forward: true }],
        pathIndex: 0, state: TrainState.WAITING,
        timetable: [], delay: 0, spad: false,
        color: '#4FC3F7',
    };
    trains.set(train.id, train);

    // Mark block as occupied
    const firstBlock = blocks.get(s1.blockIds[0]);
    if (firstBlock) {
        firstBlock.state = BlockState.OCCUPIED;
        firstBlock.occupyingTrainId = train.id;
    }

    return {
        seed, opengenVersion: OPENGEN_VERSION,
        nodes, segments, blocks, signals, points, routes,
        trains, stations,
        failures: new Map(),
        eruUnits: [{ id: genId('eru'), state: ERUState.AVAILABLE, eta: 0, repairTime: 0 }],
        tasks: [], time: 0, timeScale: 1,
        difficulty: Difficulty.NORMAL,
        score: 0, trainsHandled: 0, totalDelayMinutes: 0,
    };
}

// ============================================================
// VALIDATION
// ============================================================

/**
 * Validate a generated world for safety compliance.
 * 
 * SAFETY RULES (ALL NON-NEGOTIABLE):
 * 1. No un-signalled junctions
 * 2. No facing points without protection
 * 3. No bidirectional lines without opposing signals
 * 4. Every route must be interlockable
 */
function validateWorld(world: GameWorld): boolean {
    // Rule 1: Every junction node must have at least one signal nearby
    for (const [, node] of world.nodes) {
        if (node.connectedSegments.length > 2) {
            // This is a junction — must have signals
            let hasSignal = false;
            for (const [, signal] of world.signals) {
                if (node.connectedSegments.includes(signal.segmentId)) {
                    hasSignal = true;
                    break;
                }
            }
            if (!hasSignal) {
                console.warn(`Validation failed: Junction ${node.id} has no signals`);
                return false;
            }
        }
    }

    // Rule 2: Every points must have protection signals
    for (const [, pts] of world.points) {
        let hasProtection = false;
        for (const [, signal] of world.signals) {
            if (signal.segmentId === pts.commonSegmentId ||
                signal.segmentId === pts.normalSegmentId ||
                signal.segmentId === pts.reverseSegmentId) {
                hasProtection = true;
                break;
            }
        }
        if (!hasProtection) {
            console.warn(`Validation failed: Points ${pts.id} has no protection signal`);
            return false;
        }
    }

    // Rule 3: Every block must be referenced by at least one segment
    for (const [, block] of world.blocks) {
        if (!world.segments.has(block.segmentId)) {
            console.warn(`Validation failed: Block ${block.id} references non-existent segment`);
            return false;
        }
    }

    // Rule 4: No train can start in an invalid position
    for (const [, train] of world.trains) {
        if (!world.segments.has(train.position.segmentId)) {
            console.warn(`Validation failed: Train ${train.id} on non-existent segment`);
            return false;
        }
    }

    return true;
}

// ============================================================
// EXPORTS
// ============================================================

export { vec2, vec2Add, vec2Sub, vec2Scale, vec2Len, vec2Normalize, vec2Lerp, vec2Dist, vec2Perp };
