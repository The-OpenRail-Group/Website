/**
 * OpenRail Simulation Engine
 * 
 * The core simulation loop that drives the entire railway.
 * Handles:
 * - Train movement (continuous float positions)
 * - Signal aspect calculation
 * - Block occupancy
 * - Interlocking enforcement
 * - Route management
 * - Failure events
 * - ERU dispatch
 * 
 * This is the beating heart of OpenRail.
 * All safety logic lives here.
 */

import {
    GameWorld, Train, Signal, Block, Route, Points, Failure,
    BlockState, SignalAspect, PointsPosition, RouteState,
    TrainState, TrainType, FailureType, ERUState, Difficulty,
    EntityId, Vec2,
} from './types';
import { vec2, vec2Lerp, vec2Dist, vec2Sub, vec2Normalize } from '../opengen/generator';
import { SeededRNG } from '../opengen/seed';

// ============================================================
// SIMULATION TICK
// ============================================================

/**
 * Advance the simulation by one tick.
 * 
 * @param world - The current game world state (mutated in place)
 * @param dt - Delta time in seconds (real time * timeScale)
 */
export function simulationTick(world: GameWorld, dt: number): void {
    const scaledDt = dt * world.timeScale;
    world.time += scaledDt;

    // 1. Update train positions and physics
    updateTrains(world, scaledDt);

    // 2. Update block occupancy from train positions
    updateBlockOccupancy(world);

    // 3. Calculate signal aspects from block states
    updateSignalAspects(world);

    // 4. Update route states
    updateRoutes(world, scaledDt);

    // 5. Update ERU responses
    updateERU(world, scaledDt);

    // 6. Check for random failures (rare)
    checkForFailures(world, scaledDt);

    // 7. Update score
    updateScore(world, scaledDt);
}

// ============================================================
// TRAIN MOVEMENT
// ============================================================

/**
 * Update all train positions using physics.
 * Trains accelerate, brake, and respond to signals autonomously.
 */
function updateTrains(world: GameWorld, dt: number): void {
    world.trains.forEach((train) => {
        if (train.state === TrainState.STALLED) return;

        const segment = world.segments.get(train.position.segmentId);
        if (!segment) return;

        // Get the signal ahead of this train
        const signalAhead = getSignalAhead(world, train);

        // Determine target speed
        let targetSpeed = Math.min(train.maxSpeed, segment.speedLimit / 3.6);

        switch (train.state) {
            case TrainState.WAITING: {
                // Check if it's time to depart
                if (world.time > 30 + train.delay) {
                    train.state = TrainState.RUNNING;
                }
                targetSpeed = 0;
                break;
            }

            case TrainState.STOPPED_AT_SIGNAL: {
                targetSpeed = 0;
                // Check if signal has cleared
                if (signalAhead && signalAhead.aspect !== SignalAspect.RED) {
                    train.state = TrainState.RUNNING;
                }
                break;
            }

            case TrainState.STOPPED_AT_STATION: {
                targetSpeed = 0;
                // Check dwell time
                const currentTimetable = train.timetable.find(t => !t.completed);
                if (currentTimetable) {
                    if (world.time >= currentTimetable.departureTime) {
                        currentTimetable.completed = true;
                        train.state = TrainState.RUNNING;
                    }
                } else {
                    // No more stops, just stand
                    train.state = TrainState.RUNNING;
                }
                break;
            }

            case TrainState.RUNNING: {
                // React to signals
                if (signalAhead) {
                    const distToSignal = getDistanceToSignal(world, train, signalAhead);

                    if (signalAhead.aspect === SignalAspect.RED) {
                        // Calculate braking distance: v² / (2 * deceleration)
                        const brakingDistance = (train.speed * train.speed) / (2 * train.brakingRate);

                        if (distToSignal <= brakingDistance + 20) {
                            // Must brake now
                            targetSpeed = 0;
                            train.state = distToSignal < 5 ? TrainState.STOPPED_AT_SIGNAL : TrainState.BRAKING;
                        }
                    } else if (signalAhead.aspect === SignalAspect.YELLOW) {
                        // Caution — reduce speed
                        targetSpeed = Math.min(targetSpeed, train.maxSpeed * 0.5);
                    }
                }

                // Check for platform stops
                if (segment.isPlatform && segment.stationId) {
                    const nextStop = train.timetable.find(t => !t.completed && t.stationId === segment.stationId);
                    if (nextStop && train.position.t > 0.4 && train.position.t < 0.6) {
                        train.state = TrainState.STOPPED_AT_STATION;
                        train.speed = 0;
                        targetSpeed = 0;

                        // Calculate delay
                        const arrivalDelay = world.time - nextStop.arrivalTime;
                        if (arrivalDelay > 0) {
                            train.delay = arrivalDelay;
                        }
                    }
                }
                break;
            }

            case TrainState.BRAKING: {
                targetSpeed = 0;
                if (train.speed <= 0.1) {
                    train.speed = 0;
                    if (signalAhead && signalAhead.aspect === SignalAspect.RED) {
                        train.state = TrainState.STOPPED_AT_SIGNAL;
                    } else {
                        train.state = TrainState.RUNNING;
                    }
                }
                break;
            }
        }

        // Apply physics
        if (train.speed < targetSpeed) {
            train.speed = Math.min(targetSpeed, train.speed + train.acceleration * dt);
        } else if (train.speed > targetSpeed) {
            train.speed = Math.max(targetSpeed, train.speed - train.brakingRate * dt);
        }

        // Move train along track
        if (train.speed > 0 && segment) {
            const distanceMoved = train.speed * dt;
            const segmentLength = segment.length || 1;
            const tDelta = distanceMoved / segmentLength;

            train.position.t += tDelta;

            // Handle segment transitions
            if (train.position.t >= 1.0) {
                const overflow = train.position.t - 1.0;

                // Find next segment
                const endNode = world.nodes.get(segment.endNodeId);
                if (endNode) {
                    const nextSegId = endNode.connectedSegments.find(sid => sid !== segment.id);
                    if (nextSegId) {
                        const nextSeg = world.segments.get(nextSegId);
                        if (nextSeg) {
                            // Check if we need to enter the next segment from start or end
                            const enterFromStart = nextSeg.startNodeId === endNode.id;

                            train.position.segmentId = nextSegId;
                            train.position.t = enterFromStart ? overflow : 1.0 - overflow;
                            train.path.push({ segmentId: nextSegId, forward: enterFromStart });
                            train.pathIndex = train.path.length - 1;
                        } else {
                            // No next segment — stop at end
                            train.position.t = 1.0;
                            train.speed = 0;
                        }
                    } else {
                        // End of line
                        train.position.t = 1.0;
                        train.speed = 0;
                    }
                }
            }

            // Update world position
            const startNode = world.nodes.get(segment.startNodeId);
            const endNode = world.nodes.get(segment.endNodeId);
            if (startNode && endNode) {
                const newSeg = world.segments.get(train.position.segmentId);
                const sNode = world.nodes.get(newSeg?.startNodeId || '');
                const eNode = world.nodes.get(newSeg?.endNodeId || '');
                if (sNode && eNode) {
                    train.position.worldPos = vec2Lerp(sNode.position, eNode.position, train.position.t);
                }
            }
        }
    });
}

/**
 * Get the next signal ahead of a train.
 */
function getSignalAhead(world: GameWorld, train: Train): Signal | null {
    let nearestSignal: Signal | null = null;
    let nearestDist = Infinity;

    world.signals.forEach((signal) => {
        if (signal.segmentId === train.position.segmentId) {
            // Signal is on the same segment
            if (signal.positionT > train.position.t) {
                const dist = (signal.positionT - train.position.t) * (world.segments.get(signal.segmentId)?.length || 100);
                if (dist < nearestDist) {
                    nearestDist = dist;
                    nearestSignal = signal;
                }
            }
        }
    });

    // Also check connected segments
    if (!nearestSignal) {
        const currentSeg = world.segments.get(train.position.segmentId);
        if (currentSeg) {
            const endNode = world.nodes.get(currentSeg.endNodeId);
            if (endNode) {
                endNode.connectedSegments.forEach(segId => {
                    if (segId === currentSeg.id) return;
                    world.signals.forEach(signal => {
                        if (signal.segmentId === segId) {
                            const segLen = world.segments.get(segId)?.length || 100;
                            const dist = (1.0 - train.position.t) * currentSeg.length + signal.positionT * segLen;
                            if (dist < nearestDist) {
                                nearestDist = dist;
                                nearestSignal = signal;
                            }
                        }
                    });
                });
            }
        }
    }

    return nearestSignal;
}

/**
 * Get approximate distance from a train to a signal.
 */
function getDistanceToSignal(world: GameWorld, train: Train, signal: Signal): number {
    if (signal.segmentId === train.position.segmentId) {
        const segLen = world.segments.get(signal.segmentId)?.length || 100;
        return Math.abs(signal.positionT - train.position.t) * segLen;
    }

    // Cross-segment distance estimation
    const trainSeg = world.segments.get(train.position.segmentId);
    const sigSeg = world.segments.get(signal.segmentId);
    if (trainSeg && sigSeg) {
        const remainingOnCurrent = (1.0 - train.position.t) * trainSeg.length;
        const distOnNext = signal.positionT * sigSeg.length;
        return remainingOnCurrent + distOnNext;
    }

    return 1000; // Default far distance
}

// ============================================================
// BLOCK OCCUPANCY
// ============================================================

/**
 * Update block occupancy based on train positions.
 * This is the track circuit simulation.
 */
function updateBlockOccupancy(world: GameWorld): void {
    // Clear all non-failed blocks first
    world.blocks.forEach((block) => {
        if (!block.failed) {
            block.state = BlockState.CLEAR;
            block.occupyingTrainId = undefined;
        }
    });

    // Mark blocks occupied by trains
    world.trains.forEach((train) => {
        const segment = world.segments.get(train.position.segmentId);
        if (!segment) return;

        // Find blocks within this segment that the train occupies
        segment.blockIds.forEach(blockId => {
            const block = world.blocks.get(blockId);
            if (!block || block.failed) return;

            // Check if train position falls within this block
            const trainHeadT = train.position.t;
            const trainTailT = trainHeadT - (train.length / (segment.length || 1));

            if (trainHeadT >= block.startT && trainTailT <= block.endT) {
                block.state = BlockState.OCCUPIED;
                block.occupyingTrainId = train.id;
            }
        });
    });
}

// ============================================================
// SIGNAL ASPECTS
// ============================================================

/**
 * Calculate signal aspects based on block occupancy ahead.
 * 
 * Multi-aspect logic:
 * - If the block immediately ahead is occupied → RED
 * - If the next signal ahead is RED → YELLOW
 * - Otherwise → GREEN
 * 
 * Failed signals stay at their failed aspect.
 */
function updateSignalAspects(world: GameWorld): void {
    world.signals.forEach((signal) => {
        if (signal.failed && signal.failedAspect) {
            signal.aspect = signal.failedAspect;
            return;
        }

        // New feature: manual signal clearing
        if (!signal.cleared) {
            signal.aspect = SignalAspect.RED;
            return;
        }

        // Check the protected block
        const protectedBlock = world.blocks.get(signal.protectedBlockId);

        if (!protectedBlock) {
            // No protected block — default to RED for safety
            signal.aspect = SignalAspect.RED;
            return;
        }

        // 4-aspect signalling logic
        // If the block immediately ahead is occupied → RED
        if (protectedBlock.state === BlockState.OCCUPIED) {
            signal.aspect = SignalAspect.RED;
            return;
        }

        // Check if any route through this signal is set
        let routeSet = false;
        for (const routeId of signal.routeIds) {
            const route = world.routes.get(routeId);
            if (route && (route.state === RouteState.SET || route.state === RouteState.OCCUPIED)) {
                routeSet = true;
                break;
            }
        }

        if (!routeSet && signal.routeIds.length > 0) {
            // Signal protects a route that isn't set — stay RED
            signal.aspect = SignalAspect.RED;
            return;
        }

        // Check the next signal ahead
        const nextSignal = getNextSignalInDirection(world, signal);
        if (nextSignal) {
            if (nextSignal.aspect === SignalAspect.RED) {
                signal.aspect = SignalAspect.YELLOW;
                return;
            }
            if (nextSignal.aspect === SignalAspect.YELLOW) {
                signal.aspect = SignalAspect.DOUBLE_YELLOW;
                return;
            }
        }

        signal.aspect = SignalAspect.GREEN;
    });
}

/**
 * Find the next signal in the same direction.
 */
function getNextSignalInDirection(world: GameWorld, signal: Signal): Signal | null {
    const segment = world.segments.get(signal.segmentId);
    if (!segment) return null;

    // Look along connected segments
    const endNode = world.nodes.get(segment.endNodeId);
    if (!endNode) return null;

    let nearest: Signal | null = null;
    let nearestDist = Infinity;

    world.signals.forEach((otherSignal) => {
        if (otherSignal.id === signal.id) return;

        // Check if this signal is on a connected segment
        if (endNode.connectedSegments.includes(otherSignal.segmentId)) {
            const dist = otherSignal.positionT;
            if (dist < nearestDist) {
                nearestDist = dist;
                nearest = otherSignal;
            }
        }
    });

    return nearest;
}

// ============================================================
// ROUTE MANAGEMENT
// ============================================================

/**
 * Update route states (setting, releasing, etc.)
 */
function updateRoutes(world: GameWorld, dt: number): void {
    world.routes.forEach((route) => {
        switch (route.state) {
            case RouteState.SETTING: {
                // Check if all points are in position
                let allPointsSet = true;
                for (const req of route.pointsPositions) {
                    const pts = world.points.get(req.pointsId);
                    if (pts && pts.position !== req.requiredPosition) {
                        allPointsSet = false;
                        // Move points towards required position
                        if (pts.position === PointsPosition.MOVING) {
                            // Points are already moving — wait
                        } else if (!pts.locked && !pts.failed) {
                            pts.position = PointsPosition.MOVING;
                            // Simulate switching time
                            setTimeout(() => {
                                if (pts.position === PointsPosition.MOVING) {
                                    pts.position = req.requiredPosition;
                                }
                            }, 0);
                            // For immediate game feel, set them now
                            pts.position = req.requiredPosition;
                        }
                    }
                }

                if (allPointsSet) {
                    // Lock all points and set the route
                    for (const req of route.pointsPositions) {
                        const pts = world.points.get(req.pointsId);
                        if (pts) {
                            pts.locked = true;
                            pts.lockingRouteId = route.id;
                        }
                    }

                    route.state = RouteState.SET;

                    // Clear the entrance signal
                    const entranceSignal = world.signals.get(route.entranceSignalId);
                    if (entranceSignal) {
                        // Signal clearing is handled by aspect calculation
                    }
                }
                break;
            }

            case RouteState.OCCUPIED: {
                // Check if train has cleared all blocks
                let allClear = true;
                for (const blockId of route.blockIds) {
                    const block = world.blocks.get(blockId);
                    if (block && block.state === BlockState.OCCUPIED) {
                        allClear = false;
                        break;
                    }
                }

                if (allClear) {
                    route.state = RouteState.RELEASING;
                }
                break;
            }

            case RouteState.RELEASING: {
                // Release the route
                for (const req of route.pointsPositions) {
                    const pts = world.points.get(req.pointsId);
                    if (pts && pts.lockingRouteId === route.id) {
                        pts.locked = false;
                        pts.lockingRouteId = undefined;
                    }
                }
                route.state = RouteState.UNSET;
                break;
            }

            case RouteState.SET: {
                // Check if a train has entered the route
                let trainEntered = false;
                for (const blockId of route.blockIds) {
                    const block = world.blocks.get(blockId);
                    if (block && block.state === BlockState.OCCUPIED) {
                        trainEntered = true;
                        break;
                    }
                }

                if (trainEntered) {
                    route.state = RouteState.OCCUPIED;
                    route.approachLocked = true;
                    route.approachLockTime = world.time;
                }
                break;
            }
        }
    });
}

// ============================================================
// PLAYER ACTIONS — ROUTE SETTING
// ============================================================

/**
 * Attempt to set a route.
 * Returns explanation if the route cannot be set.
 */
export function requestRoute(world: GameWorld, routeId: EntityId): { success: boolean; reason?: string } {
    const route = world.routes.get(routeId);
    if (!route) {
        return { success: false, reason: 'Route does not exist.' };
    }

    if (route.state !== RouteState.UNSET) {
        return { success: false, reason: `Route is already ${route.state.toLowerCase()}.` };
    }

    // Check for conflicting routes
    for (const conflictId of route.conflictingRouteIds) {
        const conflict = world.routes.get(conflictId);
        if (conflict && conflict.state !== RouteState.UNSET) {
            return {
                success: false,
                reason: `Conflicting route is ${conflict.state.toLowerCase()}. Cannot set two routes that share track sections simultaneously.`,
            };
        }
    }

    // Check blocks are clear
    for (const blockId of route.blockIds) {
        const block = world.blocks.get(blockId);
        if (block && block.state === BlockState.OCCUPIED) {
            return {
                success: false,
                reason: 'Route blocked — one or more track sections are occupied by a train.',
            };
        }
    }

    // Check points are available
    for (const req of route.pointsPositions) {
        const pts = world.points.get(req.pointsId);
        if (!pts) continue;

        if (pts.locked) {
            return {
                success: false,
                reason: 'Points are locked by another route. Wait for the current route to release.',
            };
        }

        if (pts.failed) {
            return {
                success: false,
                reason: 'Points have failed. An ERU must repair them before this route can be set.',
            };
        }
    }

    // All checks passed — begin setting route
    route.state = RouteState.SETTING;
    return { success: true };
}

/**
 * Cancel (release) a route that hasn't been entered by a train.
 */
export function cancelRoute(world: GameWorld, routeId: EntityId): { success: boolean; reason?: string } {
    const route = world.routes.get(routeId);
    if (!route) {
        return { success: false, reason: 'Route does not exist.' };
    }

    if (route.approachLocked) {
        return {
            success: false,
            reason: 'Route is approach-locked. A train has committed to this route and it cannot be cancelled.',
        };
    }

    if (route.state === RouteState.OCCUPIED) {
        return {
            success: false,
            reason: 'Route is occupied by a train. Cannot cancel while a train is traversing.',
        };
    }

    if (route.state === RouteState.UNSET) {
        return { success: false, reason: 'Route is not currently set.' };
    }

    // Release points
    for (const req of route.pointsPositions) {
        const pts = world.points.get(req.pointsId);
        if (pts && pts.lockingRouteId === route.id) {
            pts.locked = false;
            pts.lockingRouteId = undefined;
        }
    }

    route.state = RouteState.UNSET;
    return { success: true };
}

// ============================================================
// SIGNAL CONTROL
// ============================================================

/**
 * Toggles a signal's cleared status manually.
 */
export function toggleSignalClear(world: GameWorld, signalId: EntityId): { success: boolean; reason?: string } {
    const signal = world.signals.get(signalId);
    if (!signal) {
        return { success: false, reason: 'Signal does not exist.' };
    }

    if (signal.failed) {
        return { success: false, reason: 'Signal has failed and cannot be controlled.' };
    }

    signal.cleared = !signal.cleared;

    // Optional: auto-request route when clearing
    if (signal.cleared && signal.routeIds.length > 0) {
        // Find best unsigned route
        const availableRouteId = signal.routeIds.find(rid => {
            const rt = world.routes.get(rid);
            return rt && rt.state === RouteState.UNSET;
        });
        if (availableRouteId) {
            requestRoute(world, availableRouteId);
        }
    }

    return { success: true };
}

/**
 * Manually flip a set of points (HARD difficulty mechanic).
 */
export function togglePoints(world: GameWorld, pointsId: EntityId): { success: boolean; reason?: string } {
    const pts = world.points.get(pointsId);
    if (!pts) {
        return { success: false, reason: 'Points do not exist.' };
    }

    if (world.difficulty !== Difficulty.HARD) {
        return { success: false, reason: 'Manual points control is only available on HARD difficulty.' };
    }

    if (pts.locked) {
        return { success: false, reason: 'Points are rigidly locked by an active route interlocking.' };
    }

    if (pts.failed) {
        return { success: false, reason: 'These points have failed and cannot be thrown manually.' };
    }

    if (pts.position === PointsPosition.NORMAL) {
        pts.position = PointsPosition.REVERSE;
    } else if (pts.position === PointsPosition.REVERSE) {
        pts.position = PointsPosition.NORMAL;
    }

    return { success: true };
}

/**
 * Manually place a signal to danger (RED).
 * Used for emergency protection.
 */
export function placeSignalToDanger(world: GameWorld, signalId: EntityId): { success: boolean; reason?: string } {
    const signal = world.signals.get(signalId);
    if (!signal) {
        return { success: false, reason: 'Signal does not exist.' };
    }

    if (signal.failed) {
        return { success: false, reason: 'Signal has failed and cannot be controlled.' };
    }

    signal.cleared = false;
    signal.aspect = SignalAspect.RED;
    return { success: true };
}

// ============================================================
// ERU SYSTEM
// ============================================================

/**
 * Update ERU responses to failures.
 */
function updateERU(world: GameWorld, dt: number): void {
    world.eruUnits.forEach((eru) => {
        switch (eru.state) {
            case ERUState.DISPATCHED:
                eru.eta -= dt;
                if (eru.eta <= 0) {
                    eru.state = ERUState.ON_SITE;
                    eru.eta = 0;
                }
                break;

            case ERUState.ON_SITE:
                eru.state = ERUState.REPAIRING;
                break;

            case ERUState.REPAIRING:
                eru.repairTime -= dt;
                if (eru.repairTime <= 0) {
                    // Repair complete
                    if (eru.targetFailureId) {
                        const failure = world.failures.get(eru.targetFailureId);
                        if (failure) {
                            failure.resolved = true;
                            failure.resolvedTimestamp = world.time;

                            // Fix the failed entity
                            resolveFailure(world, failure);
                        }
                    }
                    eru.state = ERUState.RETURNING;
                    eru.repairTime = 0;
                }
                break;

            case ERUState.RETURNING:
                eru.state = ERUState.AVAILABLE;
                eru.targetFailureId = undefined;
                break;
        }
    });
}

/**
 * Dispatch an ERU to fix a failure.
 */
export function dispatchERU(world: GameWorld, failureId: EntityId): { success: boolean; reason?: string } {
    const failure = world.failures.get(failureId);
    if (!failure) {
        return { success: false, reason: 'Failure does not exist.' };
    }

    if (failure.eruDispatched) {
        return { success: false, reason: 'An ERU has already been dispatched to this failure.' };
    }

    // Find an available ERU
    const availableEru = world.eruUnits.find(e => e.state === ERUState.AVAILABLE);
    if (!availableEru) {
        return { success: false, reason: 'No ERU units available. All units are currently attending to other failures.' };
    }

    availableEru.state = ERUState.DISPATCHED;
    availableEru.targetFailureId = failureId;
    availableEru.eta = 120 + Math.random() * 180; // 2-5 minutes
    availableEru.repairTime = 60 + Math.random() * 240; // 1-5 minutes repair

    failure.eruDispatched = true;

    return { success: true };
}

/**
 * Resolve a failure by fixing the affected entity.
 */
function resolveFailure(world: GameWorld, failure: Failure): void {
    switch (failure.type) {
        case FailureType.SIGNAL_STUCK: {
            const signal = world.signals.get(failure.entityId);
            if (signal) {
                signal.failed = false;
                signal.failedAspect = undefined;
            }
            break;
        }
        case FailureType.TRACK_CIRCUIT_FALSE_OCCUPIED:
        case FailureType.TRACK_CIRCUIT_FALSE_CLEAR: {
            const block = world.blocks.get(failure.entityId);
            if (block) {
                block.failed = false;
                block.failureType = undefined;
                block.state = BlockState.CLEAR;
            }
            break;
        }
        case FailureType.POINTS_FAILED:
        case FailureType.POINTS_JAMMED: {
            const pts = world.points.get(failure.entityId);
            if (pts) {
                pts.failed = false;
                pts.failedPosition = undefined;
                pts.health = Math.max(50, pts.health); // Partial repair
            }
            break;
        }
        case FailureType.TRAIN_STALLED: {
            const train = world.trains.get(failure.entityId);
            if (train) {
                train.state = TrainState.WAITING;
            }
            break;
        }
    }
}

// ============================================================
// RANDOM FAILURES
// ============================================================

/**
 * Check for random failures based on time and conditions.
 * Failures are rare but realistic.
 */
function checkForFailures(world: GameWorld, dt: number): void {
    // Base failure probability per second
    const baseProbability = 0.0002; // ~1 every 83 minutes on average

    // Difficulty multiplier
    const diffMultiplier = world.difficulty === 'EASY' ? 0.3 :
        world.difficulty === 'HARD' ? 2.0 : 1.0;

    const failureProbability = baseProbability * diffMultiplier * dt;

    if (Math.random() > failureProbability) return;

    // Choose what fails
    const failureTypes = [
        FailureType.SIGNAL_STUCK,
        FailureType.TRACK_CIRCUIT_FALSE_OCCUPIED,
        FailureType.POINTS_FAILED,
        FailureType.TRAIN_STALLED,
    ];

    const type = failureTypes[Math.floor(Math.random() * failureTypes.length)];
    let entityId: EntityId | null = null;

    switch (type) {
        case FailureType.SIGNAL_STUCK: {
            const signalArr = Array.from(world.signals.values()).filter(s => !s.failed);
            if (signalArr.length > 0) {
                const signal = signalArr[Math.floor(Math.random() * signalArr.length)];
                signal.failed = true;
                signal.failedAspect = SignalAspect.RED;
                entityId = signal.id;
            }
            break;
        }
        case FailureType.TRACK_CIRCUIT_FALSE_OCCUPIED: {
            const blockArr = Array.from(world.blocks.values()).filter(b => !b.failed);
            if (blockArr.length > 0) {
                const block = blockArr[Math.floor(Math.random() * blockArr.length)];
                block.failed = true;
                block.failureType = TrackCircuitFailure.FALSE_OCCUPIED;
                block.state = BlockState.OCCUPIED;
                entityId = block.id;
            }
            break;
        }
        case FailureType.POINTS_FAILED: {
            const ptsArr = Array.from(world.points.values()).filter(p => !p.failed);
            if (ptsArr.length > 0) {
                const pts = ptsArr[Math.floor(Math.random() * ptsArr.length)];
                pts.failed = true;
                pts.failedPosition = pts.position;
                entityId = pts.id;
            }
            break;
        }
        case FailureType.TRAIN_STALLED: {
            const trainArr = Array.from(world.trains.values()).filter(
                t => t.state === TrainState.RUNNING && !t.spad
            );
            if (trainArr.length > 0) {
                const train = trainArr[Math.floor(Math.random() * trainArr.length)];
                train.state = TrainState.STALLED;
                train.speed = 0;
                entityId = train.id;
            }
            break;
        }
    }

    if (entityId) {
        const failureId = `fail_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const failure: Failure = {
            id: failureId,
            type,
            entityId,
            timestamp: world.time,
            eruDispatched: false,
            resolved: false,
        };
        world.failures.set(failureId, failure);
    }
}

// ============================================================
// SCORING
// ============================================================

function updateScore(world: GameWorld, dt: number): void {
    let onTimeTrains = 0;
    let totalActiveTrains = 0;

    world.trains.forEach(train => {
        if (train.state !== TrainState.STALLED) {
            totalActiveTrains++;
            if (train.delay < 60) { // Less than 1 minute late
                onTimeTrains++;
            }
        }
    });

    if (totalActiveTrains > 0) {
        // Score slowly increases when trains are on time
        const punctualityRatio = onTimeTrains / totalActiveTrains;
        world.score += punctualityRatio * dt * 10;
    }

    // Track total delay
    let totalDelay = 0;
    world.trains.forEach(train => {
        totalDelay += Math.max(0, train.delay);
    });
    world.totalDelayMinutes = totalDelay / 60;
}

// Missing import for TrackCircuitFailure
import { TrackCircuitFailure } from './types';
